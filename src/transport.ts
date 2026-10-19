import ssh2 from "ssh2";
import type { Client, ClientChannel, ConnectConfig, SFTPWrapper } from "ssh2";
import { readFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { checkAbort, SshError, type HostProfile } from "./domain.ts";
import { localPath, quote } from "./paths.ts";
import type { HostKeys } from "./storage.ts";
import { SudoExchange, type SudoPassword } from "./sudo.ts";

export type CommandResult = {
  stdout: string; stderr: string; exitCode: number | null; signal?: string;
  truncated: boolean; timedOut: boolean; cancelled: boolean;
  outcome: "exited" | "unknown";
  elevated?: boolean;
};
export type ExecOptions = { timeoutMs?: number; stdin?: string; signal?: AbortSignal; maxBytes?: number; sudo?: SudoPassword };

/** Drains every byte while retaining only a bounded, valid UTF-8 prefix. */
class Output {
  private decoder = new StringDecoder("utf8");
  private chunks: string[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly limit: number) {}
  push(data: Buffer) {
    const room = Math.max(0, this.limit - this.size);
    this.truncated ||= data.length > room;
    if (room) { const part = data.subarray(0, room); this.size += part.length; this.chunks.push(this.decoder.write(part)); }
  }
  text() { return this.chunks.join("") + (this.truncated ? "" : this.decoder.end()); }
}

export class Connection {
  home = "/";
  alive = true;
  sftpAvailable = false;
  private sftpChannel?: SFTPWrapper;
  private sftpOpening?: Promise<SFTPWrapper>;
  private listeners = new Set<() => void>();
  constructor(readonly chain: HostProfile[], private readonly clients: Client[]) {
    for (const client of clients) {
      client.on("error", () => {});
      client.once("close", () => {
        if (!this.alive) return;
        this.alive = false;
        this.close();
        for (const listener of this.listeners) listener();
      });
    }
  }
  onClose(listener: () => void) { this.listeners.add(listener); }
  close() {
    this.alive = false;
    for (const client of this.clients.toReversed()) client.destroy();
  }
  private get client() { return this.clients[this.clients.length - 1]; }
  async initialize(signal?: AbortSignal) {
    const result = await this.exec('printf "%s\\0" "$HOME"', { signal, timeoutMs: 15_000, maxBytes: 8192 });
    const home = result.stdout.split("\0")[0];
    if (result.exitCode !== 0 || result.outcome !== "exited" || !home?.startsWith("/") || home.includes("\n")) {
      throw new SshError("EXEC_UNAVAILABLE", "Could not determine the Linux login user's home directory");
    }
    this.home = await this.directory(home, signal);
    try { await this.sftp(signal); this.sftpAvailable = true; }
    catch (error) { checkAbort(signal); if (!this.alive) throw error; }
  }
  async directory(target: string, signal?: AbortSignal) {
    const result = await this.exec(`cd -- ${quote(target)} && printf '%s\\0' "$PWD"`, { signal, timeoutMs: 15_000, maxBytes: 16_384 });
    if (result.exitCode !== 0 || result.outcome !== "exited") throw new SshError("DIRECTORY_UNAVAILABLE", `Cannot enter remote directory: ${target}`);
    const directory = result.stdout.split("\0")[0];
    if (!directory.startsWith("/")) throw new SshError("DIRECTORY_UNAVAILABLE", "Remote shell returned an invalid directory");
    return directory;
  }
  async sftp(signal?: AbortSignal): Promise<SFTPWrapper> {
    checkAbort(signal);
    if (!this.alive) throw new SshError("CONNECTION_LOST", "SSH connection closed");
    if (this.sftpChannel) return this.sftpChannel;
    this.sftpOpening ??= new Promise<SFTPWrapper>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, sftp?: SFTPWrapper) => {
        if (settled) { sftp?.end(); return; }
        settled = true; clearTimeout(timer);
        if (error || !sftp) return reject(new SshError("SFTP_UNAVAILABLE", "The server does not provide a usable SFTP subsystem; SSH commands remain available"));
        this.sftpChannel = sftp; this.sftpAvailable = true;
        sftp.on("error", () => {});
        sftp.once("close", () => { this.sftpChannel = undefined; this.sftpOpening = undefined; this.sftpAvailable = false; });
        resolve(sftp);
      };
      const timer = setTimeout(() => finish(new Error("timeout")), 15_000);
      this.client.sftp(finish);
    }).catch(error => { this.sftpOpening = undefined; throw error; });
    const channel = await this.sftpOpening;
    checkAbort(signal);
    return channel;
  }
  async exec(command: string, options: ExecOptions = {}): Promise<CommandResult> {
    checkAbort(options.signal);
    if (!this.alive) throw new SshError("CONNECTION_LOST", "SSH connection closed");
    return new Promise((resolve, reject) => {
      const stdout = new Output(options.maxBytes ?? 128 * 1024), stderr = new Output(options.maxBytes ?? 128 * 1024);
      let channel: ClientChannel | undefined;
      let finished = false, timedOut = false, cancelled = false, exited = false;
      let exitCode: number | null = null, exitSignal: string | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined, grace: ReturnType<typeof setTimeout> | undefined;
      const authentication = new AbortController();
      const cleanup = () => { authentication.abort(); clearTimeout(timer); clearTimeout(grace); options.signal?.removeEventListener("abort", abort); this.client.off("close", lost); };
      const sudo = options.sudo ? new SudoExchange({
        password: options.sudo, signal: authentication.signal,
        write: value => { channel?.write(value); },
        ready: () => { if (!finished && !cancelled && !timedOut) channel?.end(options.stdin ?? ""); },
        output: data => stderr.push(data),
        fail: error => {
          if (finished || authentication.signal.aborted) return;
          finished = true; cleanup();
          try { channel?.end(); channel?.close(); } catch {}
          reject(error);
        },
      }) : undefined;
      const finish = () => {
        if (finished) return;
        finished = true; cleanup();
        sudo?.flush();
        resolve({ stdout: stdout.text(), stderr: stderr.text(), exitCode, signal: exitSignal,
          ...(sudo ? { elevated: sudo.authenticated } : {}),
          truncated: stdout.truncated || stderr.truncated, timedOut, cancelled, outcome: exited ? "exited" : "unknown" });
      };
      const stop = () => {
        authentication.abort();
        try { channel?.signal("TERM"); } catch {}
        grace = setTimeout(() => { try { channel?.signal("KILL"); channel?.close(); } catch {} finish(); }, 1500);
      };
      const abort = () => { if (cancelled || finished) return; cancelled = true; stop(); };
      const lost = () => finish();
      this.client.once("close", lost);
      options.signal?.addEventListener("abort", abort, { once: true });
      const timeout = options.timeoutMs ?? 120_000;
      if (timeout > 0) timer = setTimeout(() => { if (finished) return; timedOut = true; stop(); }, timeout);
      try {
        this.client.exec(sudo ? sudo.command(command) : command, (error, stream) => {
          if (finished) { stream?.close(); return; }
          if (error) { finished = true; cleanup(); reject(new SshError("EXEC_FAILED", "SSH server refused the command channel")); return; }
          channel = stream;
          stream.on("data", (data: Buffer) => stdout.push(data));
          stream.stderr.on("data", (data: Buffer) => sudo ? sudo.push(data) : stderr.push(data));
          stream.on("error", finish);
          stream.on("exit", (code: number | null, signal?: string) => { exited = true; exitCode = typeof code === "number" ? code : null; exitSignal = signal; });
          stream.on("close", finish);
          if (cancelled || timedOut) { try { stream.signal("TERM"); } catch {} }
          if (!sudo) stream.end(options.stdin ?? "");
        });
      } catch { finished = true; cleanup(); reject(new SshError("EXEC_FAILED", "Could not open SSH command channel")); }
      if (options.signal?.aborted) abort();
    });
  }
}

export class Connector {
  constructor(private readonly keys: HostKeys) {}
  async connect(chain: HostProfile[], secret: (host: HostProfile, required?: boolean) => Promise<string | undefined>, signal?: AbortSignal): Promise<Connection> {
    const clients: Client[] = [];
    const abortAll = () => { for (const client of clients) client.destroy(); };
    signal?.addEventListener("abort", abortAll, { once: true });
    try {
      for (const host of chain) {
        checkAbort(signal);
        let credential = await secret(host);
        const config: ConnectConfig = {
          host: host.hostname, port: host.port, username: host.username,
          readyTimeout: 20_000, keepaliveInterval: 15_000, keepaliveCountMax: 3,
        };
        if (host.auth === "password") {
          if (credential === undefined) credential = await secret(host, true);
          if (credential === undefined) throw new SshError("CREDENTIAL_REQUIRED", `Password required for ${host.name}`, { hostId: host.id });
          config.password = credential; config.tryKeyboard = true;
        } else {
          try { config.privateKey = await readFile(localPath(host.privateKeyPath!)); }
          catch { throw new SshError("KEY_UNREADABLE", `Cannot read private key for ${host.name}`); }
          let parsed = ssh2.utils.parseKey(config.privateKey, credential);
          if (parsed instanceof Error && credential === undefined && /encrypted|passphrase/i.test(parsed.message)) {
            credential = await secret(host, true);
            parsed = ssh2.utils.parseKey(config.privateKey, credential);
          }
          if (parsed instanceof Error) {
            if (credential === undefined && /encrypted|passphrase/i.test(parsed.message)) {
              throw new SshError("CREDENTIAL_REQUIRED", `Private key passphrase required for ${host.name}`, { hostId: host.id });
            }
            throw new SshError("KEY_INVALID", `Private key cannot be unlocked or parsed for ${host.name}`, { hostId: host.id });
          }
          config.passphrase = credential;
        }
        const previous = clients.at(-1);
        if (previous) {
          config.sock = await new Promise<ClientChannel>((resolve, reject) => {
            let settled = false;
            const finish = (error?: Error, channel?: ClientChannel) => {
              if (settled) { channel?.close(); return; }
              settled = true; clearTimeout(timer); previous.off("close", closed); signal?.removeEventListener("abort", aborted);
              if (error) reject(error); else resolve(channel!);
            };
            const closed = () => finish(new SshError("JUMP_FAILED", `Jump connection closed before reaching ${host.name}`));
            const aborted = () => finish(new SshError("CANCELLED", "Jump connection cancelled"));
            const timer = setTimeout(() => finish(new SshError("JUMP_TIMEOUT", `Jump forwarding timed out for ${host.name}`)), 20_000);
            previous.once("close", closed); signal?.addEventListener("abort", aborted, { once: true });
            previous.forwardOut("127.0.0.1", 0, host.hostname, host.port, (error, channel) => {
              finish(error ? new SshError("JUMP_FAILED", `Jump forwarding failed for ${host.name}`) : undefined, channel);
            });
            if (signal?.aborted) aborted();
          });
        }
        const client = new ssh2.Client();
        clients.push(client);
        await new Promise<void>((resolve, reject) => {
          let verificationError: unknown;
          const abort = () => { client.destroy(); reject(new SshError("CANCELLED", "SSH connection cancelled")); };
          const cleanup = () => signal?.removeEventListener("abort", abort);
          config.hostVerifier = (key: Buffer, callback: (valid: boolean) => void) => {
            void this.keys.verify(host, key).then(() => callback(true), error => { verificationError = error; callback(false); });
          };
          let promptsAnswered = 0;
          client.on("keyboard-interactive", (_name, _instructions, _language, prompts, finish) => {
            const passwordOnly = prompts.length === 1 && !prompts[0].echo && /password|密码/i.test(prompts[0].prompt) && !/otp|token|verification|one.time|验证码/i.test(prompts[0].prompt);
            if (!passwordOnly || promptsAnswered++ > 0 || credential === undefined) {
              finish([]); return;
            }
            finish([credential]);
          });
          client.once("ready", () => { cleanup(); resolve(); });
          client.on("error", error => { cleanup(); reject(verificationError ?? new SshError("CONNECT_FAILED", `SSH connection to ${host.name} failed (${(error as Error & { level?: string }).level ?? "network"})`, { hostId: host.id })); });
          client.once("close", () => { cleanup(); reject(new SshError("CONNECTION_LOST", `Connection closed during login to ${host.name}`)); });
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) { abort(); return; }
          client.connect(config);
        });
      }
      const connection = new Connection(chain, clients);
      await connection.initialize(signal);
      return connection;
    } catch (error) { for (const client of clients.toReversed()) client.destroy(); throw error; }
    finally { signal?.removeEventListener("abort", abortAll); }
  }
}
