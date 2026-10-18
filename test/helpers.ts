import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SecretBackend } from "../src/credentials.ts";

export class MemoryVault implements SecretBackend {
  values = new Map<string, string>();
  async get(id: string) { return this.values.get(id); }
  async set(id: string, value: string) { this.values.set(id, value); }
  async delete(id: string) { this.values.delete(id); }
}
export async function temporary() {
  const base = process.platform === "win32" ? path.join(process.env.LOCALAPPDATA!, "Temp", "opencode") : tmpdir();
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, "remote-ssh-test-"));
  return { directory, close: () => rm(directory, { recursive: true, force: true }) };
}
