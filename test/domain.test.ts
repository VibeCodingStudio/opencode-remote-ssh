import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Profiles, HostKeys } from "../src/storage.ts";
import { Credentials, SystemSecrets } from "../src/credentials.ts";
import { remotePath, quote } from "../src/paths.ts";
import { RemoteRuntime } from "../src/runtime.ts";
import { MemoryVault, temporary } from "./helpers.ts";

test("host configuration preserves IDs, rejects duplicate names and jump cycles", async t => {
  const temp = await temporary(); t.after(temp.close);
  const profiles = new Profiles(path.join(temp.directory, "hosts.json")); await profiles.load();
  const first = await profiles.save({ name: "开发", hostname: "dev", username: "dev", auth: "password" });
  const second = await profiles.save({ name: "跳板", hostname: "jump", username: "jump", auth: "password", jumpHostId: first.id });
  await assert.rejects(profiles.save({ name: "开发", hostname: "different", username: "x", auth: "password" }), /unique/);
  await assert.rejects(profiles.save({ id: first.id, name: "开发", hostname: "dev", username: "dev", auth: "password", jumpHostId: second.id }), /cycle/);
  assert.equal(profiles.get(first.id).jumpHostId, undefined);
  const renamed = await profiles.save({ id: first.id, name: "开发改名", hostname: "dev", username: "dev", auth: "password" });
  assert.equal(renamed.id, first.id);
  assert.deepEqual(profiles.chain(second.id).map(h => h.id), [first.id, second.id]);
  await assert.rejects(profiles.remove(first.id), /jump host/);
  const reloaded = new Profiles(path.join(temp.directory, "hosts.json")); await reloaded.load();
  assert.equal(reloaded.get(first.id).name, "开发改名");
});
test("host identity is accepted once, survives reload, rejects key changes", async t => {
  const temp = await temporary(); t.after(temp.close);
  const file = path.join(temp.directory, "keys.json"), host = { hostname: "server", port: 22 };
  const keys = new HostKeys(file); await keys.load();
  await keys.verify(host, Buffer.from("first"));
  const again = new HostKeys(file); await again.load();
  await again.verify(host, Buffer.from("first"));
  await assert.rejects(again.verify(host, Buffer.from("changed")), /identity changed/);
  await again.forget(host); await again.verify(host, Buffer.from("changed"));
});
test("only opted-in secrets survive a new credentials instance", async () => {
  const vault = new MemoryVault(), first = new Credentials(vault);
  const temporary = await first.create("temporary-secret", false), persistent = await first.create("remembered-secret", true);
  const second = new Credentials(vault);
  assert.equal(await first.get(temporary.id, false), "temporary-secret");
  assert.equal(await second.get(temporary.id, false), undefined);
  assert.equal(await second.get(persistent.id, true), "remembered-secret");
});
test("credential persistence failure never saves a host containing plaintext", async t => {
  const temp = await temporary(); t.after(temp.close);
  const backend = new MemoryVault(); backend.set = async () => { throw new Error("vault locked"); };
  const runtime = new RemoteRuntime(temp.directory, backend); await runtime.load();
  await assert.rejects(runtime.save({ name: "dev", hostname: "dev", username: "user", auth: "password" }, "private-value", true), /vault locked/);
  assert.equal(runtime.profiles.list().length, 0);
  await runtime.save({ name: "dev", hostname: "dev", username: "user", auth: "password" }, "private-value", false);
  assert.ok(!(await readFile(path.join(temp.directory, "hosts.json"), "utf8")).includes("private-value"));
});
test("Linux remote paths do not acquire Windows separators; shell quoting handles apostrophes", () => {
  assert.equal(remotePath("../logs/a b.txt", "/srv/project", "/home/dev"), "/srv/logs/a b.txt");
  assert.equal(remotePath("~/x", "/srv/project", "/home/dev"), "/home/dev/x");
  assert.equal(quote("a'b"), "'a'\\''b'");
  assert.throws(() => remotePath("~root", "/", "/home/dev"));
});
test("Windows DPAPI backend persists ciphertext and can decrypt it", { skip: process.platform !== "win32" }, async t => {
  const temp = await temporary(); t.after(temp.close);
  const vault = new SystemSecrets(temp.directory), credentials = new Credentials(vault);
  const { id } = await credentials.create("fixture-口令-🗝-private", true);
  const bytes = await readFile(path.join(temp.directory, `${id}.dpapi`));
  assert.ok(!bytes.includes(Buffer.from("fixture-口令-🗝-private")));
  assert.equal(await new Credentials(vault).get(id, true), "fixture-口令-🗝-private");
  await credentials.remove(id, true);
  assert.equal(await new Credentials(vault).get(id, true), undefined);
});
