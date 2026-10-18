import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Profiles, HostKeys } from "./storage.ts";
import { Credentials, SystemSecrets, type SecretBackend } from "./credentials.ts";
import { Connector, type Connection } from "./transport.ts";
import { Serial, SshError, checkAbort, type HostDraft, type HostProfile, type HostStatus, type RemoteTarget } from "./domain.ts";
import { remotePath, dataDirectory } from "./paths.ts";

export const SNAPSHOT_KEY = "studio.remote-ssh.snapshot";
export type CredentialRequest = { id: string; hostId: string; hostName: string; kind: "password" | "passphrase"; sessionId: string };
type Pending = CredentialRequest & { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Slot = { chain: HostProfile[]; connection?: Connection; pending?: Promise<Connection>; controller: AbortController; status: HostStatus["status"]; error?: string };
type SessionState = { target?: RemoteTarget; directories: Map<string, string>; blocked: Set<string>; slots: Map<string, Slot>; serial: Serial };
export type StateView = { hosts: HostStatus[]; target?: RemoteTarget; requests: CredentialRequest[] };
export type SnapshotPublisher = (token: string) => Promise<void>;

export class RemoteRuntime {
  readonly profiles: Profiles;
  readonly keys: HostKeys;
  readonly credentials: Credentials;
  private readonly connector: Connector;
  private readonly sessions = new Map<string, SessionState>();
  private readonly snapshots = new Map<string, RemoteTarget | undefined>();
  private readonly requests = new Map<string, Pending>();
  private readonly events = new EventEmitter();
  private readonly deleting = new Set<string>();
  private readonly configSerial = new Serial();
  private owners = 0;
  private idleCleanup?: ReturnType<typeof setTimeout>;

  constructor(directory: string, secrets?: SecretBackend, connector?: Connector) {
    this.profiles = new Profiles(path.join(directory, "hosts.json"));
    this.keys = new HostKeys(path.join(directory, "known-hosts.json"));
    this.credentials = new Credentials(secrets ?? new SystemSecrets(path.join(directory, "credentials")));
    this.connector = connector ?? new Connector(this.keys);
    this.events.setMaxListeners(0);
  }
  async load() { await Promise.all([this.profiles.load(), this.keys.load()]); }
  retain() {
    this.owners++; clearTimeout(this.idleCleanup);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.owners !== 0) return;
      // Allow plugin reloads to reuse process state; release sockets once no location owns the plugin.
      this.idleCleanup = setTimeout(() => {
        for (const state of this.sessions.values()) {
          for (const slot of state.slots.values()) { slot.controller.abort(); slot.connection?.close(); }
          state.slots.clear();
        }
        this.changed();
      }, 250);
      this.idleCleanup.unref();
    };
  }
  onChange(listener: () => void) { this.events.on("change", listener); return () => { this.events.off("change", listener); }; }
  private changed() { this.events.emit("change"); }
  session(id: string, snapshotToken?: unknown) {
    let state = this.sessions.get(id);
    if (!state) {
      const snapshot = typeof snapshotToken === "string" ? this.snapshots.get(snapshotToken) : undefined;
      state = { target: snapshot ? { ...snapshot } : undefined, directories: new Map(), blocked: new Set(), slots: new Map(), serial: new Serial() };
      if (snapshot) state.directories.set(snapshot.hostId, snapshot.directory);
      this.sessions.set(id, state);
    }
    return state;
  }
  target(id: string) { const target = this.session(id).target; return target ? { ...target } : undefined; }
  resolve(id: string, selector?: string): { host: HostProfile; directory?: string } {
    const state = this.session(id);
    if (!selector && !state.target) throw new SshError("NO_TARGET", "No remote target selected; use ssh_list_hosts then ssh_set_workspace");
    const host = this.profiles.get(selector ?? state.target?.hostId ?? "");
    return { host, directory: state.directories.get(host.id) };
  }
  state(id?: string): StateView {
    const session = id ? this.session(id) : undefined;
    return {
      hosts: this.profiles.list().map(host => {
        const slot = session?.slots.get(host.id);
        const changed = !!slot && slot.chain.some(snapshot => {
          try { return this.profiles.get(snapshot.id).revision !== snapshot.revision; } catch { return true; }
        });
        return { host, status: slot?.status ?? "disconnected", directory: session?.directories.get(host.id), home: slot?.connection?.home,
          current: session?.target?.hostId === host.id, changed, sftp: slot?.connection?.sftpAvailable, error: slot?.error };
      }),
      target: session?.target ? { ...session.target } : undefined,
      requests: [...this.requests.values()].map(({ id, hostId, hostName, kind, sessionId }) => ({ id, hostId, hostName, kind, sessionId })),
    };
  }
  private used(id: string) {
    for (const session of this.sessions.values()) for (const slot of session.slots.values()) {
      if ((slot.status === "connected" || slot.status === "connecting") && slot.chain.some(host => host.id === id)) return true;
    }
    return false;
  }
  async save(draft: HostDraft, secret?: string, remember?: boolean) {
    return this.configSerial.run(async () => {
      const old = draft.id ? this.profiles.get(draft.id) : undefined;
      let credential: { id?: string; remembered: boolean } | undefined;
      if (secret !== undefined) credential = await this.credentials.create(secret, remember ?? false);
      else if (old && (old.auth !== draft.auth || old.privateKeyPath !== draft.privateKeyPath || remember !== undefined && remember !== old.remembered)) {
        if (remember && old.auth === draft.auth) {
          const value = await this.credentials.get(old.credentialId, old.remembered);
          if (value === undefined) throw new SshError("CREDENTIAL_REQUIRED", "Enter the credential before remembering it");
          credential = await this.credentials.create(value, true);
        } else if (old.auth === draft.auth && old.privateKeyPath === draft.privateKeyPath) {
          const value = await this.credentials.get(old.credentialId, old.remembered);
          credential = value === undefined ? { remembered: false } : await this.credentials.create(value, false);
        } else credential = { remembered: false };
      }
      try {
        const host = await this.profiles.save(draft, credential);
        if (credential && old?.credentialId) await this.credentials.remove(old.credentialId, old.remembered).catch(() => {});
        this.changed(); return host;
      } catch (error) {
        if (credential) await this.credentials.remove(credential.id, credential.remembered).catch(() => {});
        throw error;
      }
    });
  }
  async deleteHost(id: string) {
    return this.configSerial.run(async () => {
      if (this.used(id)) throw new SshError("HOST_IN_USE", "Host is in use by an active session");
      const host = this.profiles.get(id);
      this.deleting.add(id);
      try {
        await this.profiles.remove(id);
        await this.credentials.remove(host.credentialId, host.remembered);
        for (const state of this.sessions.values()) {
          if (state.target?.hostId === id) state.target = undefined;
          state.directories.delete(id); state.slots.delete(id); state.blocked.delete(id);
        }
        for (const [token, target] of this.snapshots) if (target?.hostId === id) this.snapshots.delete(token);
        this.changed();
      } finally { this.deleting.delete(id); }
    });
  }
  async forgetHostKey(id: string) {
    if (this.used(id)) throw new SshError("HOST_IN_USE", "Disconnect sessions using this host before updating its identity record");
    await this.keys.forget(this.profiles.get(id));
  }
  private async secret(host: HostProfile, sessionId: string, signal: AbortSignal, required = false): Promise<string | undefined> {
    let value = await this.credentials.get(host.credentialId, host.remembered);
    if (value !== undefined || !required) return value;
    checkAbort(signal);
    await new Promise<void>((resolve, reject) => {
      const id = randomUUID();
      const abort = () => { const pending = this.requests.get(id); if (pending) { clearTimeout(pending.timer); this.requests.delete(id); this.changed(); } reject(new SshError("CANCELLED", "Credential input cancelled")); };
      const cleanup = () => signal.removeEventListener("abort", abort);
      const timer = setTimeout(() => { cleanup(); this.requests.delete(id); this.changed(); reject(new SshError("CREDENTIAL_REQUIRED", `Enter credentials for ${host.name} in /ssh and retry`)); }, 120_000);
      this.requests.set(id, { id, hostId: host.id, hostName: host.name, kind: host.auth === "key" ? "passphrase" : "password", sessionId,
        timer, resolve: () => { cleanup(); resolve(); }, reject: error => { cleanup(); reject(error); } });
      signal.addEventListener("abort", abort, { once: true }); this.changed();
      if (signal.aborted) abort();
    });
    const updated = this.profiles.get(host.id);
    value = await this.credentials.get(updated.credentialId, updated.remembered);
    // A credential-only update during login belongs to the connection being established.
    if (host.hostname === updated.hostname && host.username === updated.username && host.auth === updated.auth && host.privateKeyPath === updated.privateKeyPath && host.port === updated.port && host.jumpHostId === updated.jumpHostId) {
      Object.assign(host, updated);
    }
    return value;
  }
  async replyCredential(id: string, value?: string, remember = false) {
    const request = this.requests.get(id);
    if (!request) return;
    if (value === undefined) {
      clearTimeout(request.timer); this.requests.delete(id); request.reject(new SshError("CREDENTIAL_CANCELLED", "Credential input cancelled")); this.changed(); return;
    }
    const host = this.profiles.get(request.hostId);
    const { revision: _revision, credentialId: _credential, remembered: _remembered, ...draft } = host;
    await this.save(draft, value, remember);
    clearTimeout(request.timer); this.requests.delete(id); request.resolve(); this.changed();
  }
  async connection(id: string, hostId: string, explicit: boolean, signal?: AbortSignal): Promise<Connection> {
    const state = this.session(id);
    if (explicit) state.blocked.delete(hostId);
    if (state.blocked.has(hostId)) throw new SshError("MANUALLY_DISCONNECTED", "This host was explicitly disconnected; use ssh_set_workspace or connect in the sidebar");
    const previous = state.slots.get(hostId);
    if (previous?.connection?.alive) return previous.connection;
    if (previous?.pending) return previous.pending;
    const chain = this.profiles.chain(hostId);
    if (chain.some(host => this.deleting.has(host.id))) throw new SshError("HOST_IN_USE", "Host configuration is being removed");
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const slot: Slot = { chain, controller, status: "connecting" };
    state.slots.set(hostId, slot); this.changed();
    const pending = (async () => {
      let connection: Connection | undefined;
      try {
        connection = await this.connector.connect(chain, (host, required) => this.secret(host, id, combined, required), combined);
        checkAbort(combined);
        const priorDirectory = state.directories.get(hostId);
        if (priorDirectory) await connection.directory(priorDirectory, combined);
        else state.directories.set(hostId, connection.home);
        checkAbort(combined);
        slot.connection = connection; slot.status = "connected";
        connection.onClose(() => {
          if (state.slots.get(hostId) !== slot || state.blocked.has(hostId)) return;
          slot.status = "error"; slot.error = "Connection lost; the next operation can reconnect"; this.changed();
        });
        this.changed(); return connection;
      } catch (error) {
        connection?.close(); slot.status = "error";
        slot.error = error instanceof Error ? error.message : "Connection failed";
        this.changed(); throw error;
      } finally { slot.pending = undefined; }
    })();
    slot.pending = pending;
    return pending;
  }
  private async commit(state: SessionState, target: RemoteTarget | undefined, publish: SnapshotPublisher) {
    const token = randomUUID();
    this.snapshots.set(token, target ? { ...target } : undefined);
    try { await publish(token); }
    catch (error) { this.snapshots.delete(token); throw error; }
    state.target = target; this.changed();
  }
  async setWorkspace(id: string, selector: string | undefined, directory: string | undefined, publish: SnapshotPublisher, signal?: AbortSignal) {
    const state = this.session(id);
    return state.serial.run(async () => {
      const { host } = this.resolve(id, selector);
      const connection = await this.connection(id, host.id, true, signal);
      const next = remotePath(directory, state.directories.get(host.id) ?? connection.home, connection.home);
      const resolved = await connection.directory(next, signal);
      checkAbort(signal);
      await this.commit(state, { hostId: host.id, directory: resolved }, publish);
      state.directories.set(host.id, resolved); this.changed();
      return { hostId: host.id, hostName: host.name, directory: resolved };
    });
  }
  async disconnect(id: string, hostId: string, publish: SnapshotPublisher) {
    const state = this.session(id);
    return state.serial.run(async () => {
      if (state.target?.hostId === hostId) await this.commit(state, undefined, publish);
      state.blocked.add(hostId);
      const slot = state.slots.get(hostId);
      slot?.controller.abort(); slot?.connection?.close();
      state.slots.delete(hostId); state.directories.delete(hostId); this.changed();
    });
  }
  async reset(id: string, hostId: string, signal?: AbortSignal) {
    const state = this.session(id);
    if (state.blocked.has(hostId)) throw new SshError("MANUALLY_DISCONNECTED", "Use ssh_set_workspace to reconnect a manually disconnected host");
    const slot = state.slots.get(hostId);
    slot?.controller.abort(); slot?.connection?.close(); state.slots.delete(hostId);
    await this.connection(id, hostId, false, signal);
    this.changed(); return { hostId, directory: state.directories.get(hostId) };
  }
  async test(hostId: string, signal?: AbortSignal) {
    const id = `test:${randomUUID()}`;
    try {
      const connection = await this.connection(id, hostId, true, signal);
      return { home: connection.home, exec: true, sftp: connection.sftpAvailable, hops: connection.chain.map(host => host.name) };
    } finally { this.release(id); }
  }
  release(id: string) {
    const state = this.sessions.get(id);
    if (!state) return;
    for (const slot of state.slots.values()) { slot.controller.abort(); slot.connection?.close(); }
    this.sessions.delete(id); this.changed();
  }
  close() { clearTimeout(this.idleCleanup); for (const id of this.sessions.keys()) this.release(id); this.snapshots.clear(); }
}

const SINGLETON = Symbol.for("studio.opencode-remote-ssh.runtime.v1");
export function runtime(): Promise<RemoteRuntime> {
  const globals = globalThis as typeof globalThis & { [SINGLETON]?: Promise<RemoteRuntime> };
  return globals[SINGLETON] ??= (async () => { const result = new RemoteRuntime(dataDirectory()); await result.load(); return result; })().catch(error => { delete globals[SINGLETON]; throw error; });
}
