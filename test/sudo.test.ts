import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { parse } from "shell-quote";
import { SudoExchange, SudoCredentials, sudoIdentity } from "../src/sudo.ts";
import { Credentials } from "../src/credentials.ts";
import { RemoteRuntime, type CredentialRequest } from "../src/runtime.ts";
import type { Connection, ExecOptions } from "../src/transport.ts";
import { MemoryVault, temporary } from "./helpers.ts";

function request(runtime: RemoteRuntime): Promise<CredentialRequest> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("No credential request")); }, 1000);
    const check = () => { const pending = runtime.state().requests[0]; if (pending) { clearTimeout(timer); unsubscribe(); resolve(pending); } };
    const unsubscribe = runtime.onChange(check); check();
  });
}

test("sudo stream handles fragmented prompts and releases stdin only after authentication", async () => {
  const writes: string[] = [], output: Buffer[] = [];
  let ready = false;
  const exchange = new SudoExchange({
    signal: new AbortController().signal, password: async () => "test-password",
    write: value => writes.push(value), output: value => output.push(value),
    ready: () => { ready = true; writes.push("command-input"); }, fail: error => { throw error; },
  });
  const command = exchange.command("cat; printf '%s' 'quoted command'");
  assert.ok(!command.includes("test-password"));
  const tokens = parse(command);
  const prompt = tokens[3] as string;
  const marker = /remote-ssh-root-[\da-f-]+/.exec(command)![0];
  for (const byte of Buffer.from(`notice\n${prompt}`)) exchange.push(Buffer.from([byte]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ready, false); assert.deepEqual(writes, ["test-password\n"]);
  for (const byte of Buffer.from(marker + "错误\n")) exchange.push(Buffer.from([byte]));
  exchange.flush();
  assert.equal(ready, true); assert.deepEqual(writes, ["test-password\n", "command-input"]);
  assert.equal(Buffer.concat(output).toString(), "notice\n错误\n");
});

test("sudo credentials persist only by opt-in and are bound to the host connection identity", async t => {
  const temp = await temporary(); t.after(temp.close);
  const vault = new MemoryVault(), file = path.join(temp.directory, "sudo.json");
  const store = new SudoCredentials(file, new Credentials(vault)); await store.load();
  await store.set("host", "identity", "temporary", false);
  assert.equal(await store.get("host", "identity"), "temporary");
  assert.equal(await store.get("host", "other"), undefined);
  const reload = new SudoCredentials(file, new Credentials(vault)); await reload.load();
  assert.equal(await reload.get("host", "identity"), undefined);
  await store.set("host", "identity", "remembered-secret", true);
  assert.ok(!(await readFile(file, "utf8")).includes("remembered-secret"));
  await reload.load(); assert.equal(await reload.get("host", "identity"), "remembered-secret");
  await reload.remove("host"); assert.equal(vault.values.size, 0);
});

test("sudo prompts allow explicit SSH password reuse, cache separately, retry and cancel cleanly", async t => {
  const temp = await temporary(); t.after(temp.close);
  const runtime = new RemoteRuntime(temp.directory, new MemoryVault()); await runtime.load(); t.after(() => runtime.close());
  const host = await runtime.save({ name: "host", hostname: "example.test", username: "dev", auth: "password" }, "ssh-secret", false);
  let retry = false, used: string | undefined;
  const controller = new AbortController();
  const connection = { chain: [host], exec: async (_command: string, options: ExecOptions) => {
    used = await options.sudo!(controller.signal, retry);
    return { elevated: true, exitCode: 0, outcome: "exited" };
  } } as unknown as Connection;
  const first = runtime.execSudo("s", connection, "id -u", {});
  const prompt = await request(runtime);
  assert.equal(prompt.kind, "sudo"); assert.equal(prompt.canReuseSSH, true);
  assert.ok(!JSON.stringify(runtime.state()).includes("ssh-secret"));
  await runtime.replyCredential(prompt.id, undefined, false, true); await first;
  assert.equal(used, "ssh-secret");
  await runtime.execSudo("s", connection, "id -u", {});
  assert.equal(runtime.state().requests.length, 0);
  retry = true;
  const next = runtime.execSudo("s", connection, "id -u", {});
  const again = await request(runtime);
  assert.equal(again.canReuseSSH, false); assert.equal(again.retry, true);
  await runtime.replyCredential(again.id, "sudo-only", false); await next;
  assert.equal(used, "sudo-only");
  assert.equal(await runtime.credentials.get(host.credentialId, host.remembered), "ssh-secret");
  const cancelled = runtime.execSudo("s", connection, "id -u", {});
  const rejection = assert.rejects(cancelled, /cancelled/);
  const cancel = await request(runtime); await runtime.replyCredential(cancel.id); await rejection;
  assert.equal(runtime.state().requests.length, 0);
  assert.equal(await runtime.sudoCredentials.get(host.id, sudoIdentity([host])), undefined);
  await runtime.save({ id: host.id, name: host.name, hostname: "different.test", username: "dev", auth: "password" });
  await assert.rejects(runtime.execSudo("s", connection, "id -u", {}), /Reconnect/);
});
