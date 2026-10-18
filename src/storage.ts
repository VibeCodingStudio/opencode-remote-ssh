import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { HostInput, StoredHost, Serial, SshError, type HostDraft, type HostProfile } from "./domain.ts";

export async function readJson(file: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}
export class Profiles {
  private hosts: HostProfile[] = [];
  private serial = new Serial();
  constructor(private readonly file: string) {}
  async load() { this.hosts = z.array(StoredHost).parse(await readJson(this.file) ?? []); }
  list(): HostProfile[] { return structuredClone(this.hosts); }
  get(selector: string): HostProfile {
    const host = this.hosts.find(h => h.id === selector || h.name === selector);
    if (!host) throw new SshError("HOST_NOT_FOUND", `Unknown SSH host: ${selector}`);
    return structuredClone(host);
  }
  chain(selector: string): HostProfile[] {
    const chain: HostProfile[] = [], seen = new Set<string>();
    let host: HostProfile | undefined = this.get(selector);
    while (host) {
      if (seen.has(host.id)) throw new SshError("JUMP_CYCLE", "ProxyJump chain contains a cycle");
      if (chain.length >= 16) throw new SshError("JUMP_LIMIT", "ProxyJump supports at most 16 hops");
      seen.add(host.id); chain.unshift(host);
      host = host.jumpHostId ? this.get(host.jumpHostId) : undefined;
    }
    return chain;
  }
  async save(draft: HostDraft, credential?: { id?: string; remembered: boolean }) {
    return this.serial.run(async () => {
      const input = HostInput.parse(draft);
      const old = input.id ? this.get(input.id) : undefined;
      const id = old?.id ?? randomUUID();
      if (this.hosts.some(h => h.id !== id && h.name.toLowerCase() === input.name.toLowerCase())) {
        throw new SshError("NAME_EXISTS", "Host names must be unique");
      }
      const host: HostProfile = {
        ...input, id, revision: (old?.revision ?? 0) + 1,
        credentialId: credential ? credential.id : old?.credentialId,
        remembered: credential ? credential.remembered : old?.remembered ?? false,
      };
      const connectionFields = (h: HostProfile) => JSON.stringify([h.hostname, h.port, h.username, h.auth, h.privateKeyPath, h.jumpHostId, h.credentialId]);
      if (old && connectionFields(old) === connectionFields(host)) host.revision = old.revision;
      const before = this.hosts;
      this.hosts = [...before.filter(h => h.id !== id), host];
      try { this.chain(id); await atomicJson(this.file, this.hosts); }
      catch (error) { this.hosts = before; throw error; }
      return structuredClone(host);
    });
  }
  async remove(id: string) {
    await this.serial.run(async () => {
      this.get(id);
      if (this.hosts.some(h => h.jumpHostId === id)) throw new SshError("HOST_IN_USE", "Another host uses this host as a jump host");
      const next = this.hosts.filter(h => h.id !== id);
      await atomicJson(this.file, next); this.hosts = next;
    });
  }
}
const Pins = z.record(z.string(), z.object({ fingerprint: z.string(), firstSeen: z.string() }));
export class HostKeys {
  private pins: z.infer<typeof Pins> = {};
  private serial = new Serial();
  constructor(private readonly file: string) {}
  async load() { this.pins = Pins.parse(await readJson(this.file) ?? {}); }
  async verify(host: Pick<HostProfile, "hostname" | "port">, key: Buffer) {
    return this.serial.run(async () => {
      const address = JSON.stringify([host.hostname.toLowerCase(), host.port]);
      const fingerprint = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
      const pin = this.pins[address];
      if (pin && pin.fingerprint !== fingerprint) throw new SshError("HOST_KEY_CHANGED", `Server identity changed for ${host.hostname}:${host.port}`, { expected: pin.fingerprint, received: fingerprint });
      if (!pin) {
        const next = { ...this.pins, [address]: { fingerprint, firstSeen: new Date().toISOString() } };
        await atomicJson(this.file, next); this.pins = next;
      }
      return fingerprint;
    });
  }
  async forget(host: Pick<HostProfile, "hostname" | "port">) {
    await this.serial.run(async () => {
      const next = { ...this.pins };
      delete next[JSON.stringify([host.hostname.toLowerCase(), host.port])];
      await atomicJson(this.file, next); this.pins = next;
    });
  }
}
