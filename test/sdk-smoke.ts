import assert from "node:assert/strict";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { Plugin } from "@opencode/plugin";
import { OpenCode } from "@opencode/sdk";
import plugin from "../src/index.ts";
import { RemoteSsh } from "../src/rpc.ts";
import type { StateView } from "../src/runtime.ts";
import { errorText } from "../src/domain.ts";

if (!process.env.REMOTE_SSH_SMOKE_DIR) throw new Error("Run through test/run-sdk.ts");
const temp = { directory: process.env.REMOTE_SSH_SMOKE_DIR };
process.env.OPENCODE_REMOTE_SSH_DATA_DIR = path.join(temp.directory, "ssh");
await mkdir(path.join(temp.directory, "config"));
let registered: string[] = [];
const inspector = Plugin.define({ id: "remote-ssh-test-inspector", async setup(ctx) {
  registered = (await ctx.tool.list()).filter(tool => tool.name.startsWith("ssh_")).map(tool => tool.name);
} });
let host: Awaited<ReturnType<typeof OpenCode.create>> | undefined;
try {
  host = await OpenCode.create({
    database: { path: path.join(temp.directory, "test.db") },
    config: { directory: path.join(temp.directory, "config"), project: false, claude: false },
    models: { fetch: false, snapshot: false }, fs: { filewatcher: false, fff: false },
    pty: { root: path.join(temp.directory, "pty") }, plugins: [plugin, inspector],
  });
  await host.sessions.create({ location: { directory: temp.directory } });
  const rpc = host.rpc(RemoteSsh);
  const state = await rpc.state({}, { location: { directory: temp.directory } }) as StateView;
  assert.equal(state.hosts.length, 0);
  assert.equal(registered.length, 14);
  await rpc.save({ host: { name: "SDK fixture", hostname: "127.0.0.1", port: 22, username: "tester", auth: "password" }, secret: "temporary-fixture-secret", remember: false }, { location: { directory: temp.directory } });
  const saved = await rpc.state({}, { location: { directory: temp.directory } }) as StateView;
  assert.equal(saved.hosts[0].host.name, "SDK fixture");
  assert.ok(!JSON.stringify(saved).includes("temporary-fixture-secret"));
  await assert.rejects(rpc.save({ host: { name: "SDK fixture", hostname: "different", port: 22, username: "tester", auth: "password" } }, { location: { directory: temp.directory } }), error => errorText(error) === "Host names must be unique");
  await rpc.manage({ action: "delete", hostId: saved.hosts[0].host.id }, { location: { directory: temp.directory } });
  console.log("OpenCode 2 SDK: plugin setup, 14 tools and typed RPC passed (no model calls).");
} catch (error) {
  console.error("SDK verification failed:", error);
  throw error;
} finally {
  await host?.close();
}
