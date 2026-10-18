import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile, rm } from "node:fs/promises";
import type { Plugin } from "@opencode/plugin";
import type { Info, ToolContext } from "@opencode/plugin/promise/tool";
import { registerTools, schemas } from "../src/tools.ts";
import { RemoteRuntime } from "../src/runtime.ts";
import type { Connection } from "../src/transport.ts";
import { shellResources } from "../src/authorization.ts";
import { MemoryVault, temporary } from "./helpers.ts";

test("shell authorization exposes compound and quoted command names without evaluating variables", () => {
  const resources = shellResources('echo ok && r"m" -rf ./temp; git push origin main');
  assert.ok(resources.includes("rm -rf ./temp"));
  assert.ok(resources.includes("git push origin main"));
  assert.ok(shellResources("pwd\ngit push").includes("git push"));
  assert.ok(shellResources("echo $HOME").some(s => s.includes("$HOME")));
});
test("SSH tools preserve native permission rejection and exclude writes from readonly agents", async t => {
  const temp = await temporary(); t.after(temp.close);
  const runtime = new RemoteRuntime(temp.directory, new MemoryVault()); await runtime.load();
  const host = await runtime.save({ name: "test", hostname: "localhost", username: "tester", auth: "password" });
  const tools = new Map<string, Info>();
  let performed = 0, deny: unknown, denyAction: string | undefined;
  const checks: { action: string; resources: string[] }[] = [];
  runtime.connection = async () => ({ home: "/home/tester", alive: true,
    exec: async () => { performed++; throw new Error("must not execute when denied"); },
  }) as unknown as Connection;
  const ctx = {
    tool: { transform: async (callback: (editor: { add: (tool: Info) => void }) => void) => callback({ add: tool => { tools.set(tool.name, tool); } }) },
    session: { get: async () => ({ location: { directory: temp.directory } }) },
    permission: { assert: async (input: { action: string; resources: string[] }) => { checks.push(input); if (deny && (!denyAction || input.action === denyAction)) throw deny; } },
  } as unknown as Plugin.Context;
  await registerTools(ctx, runtime);
  assert.equal(tools.size, 14);
  const call = (agent: string) => ({ sessionID: "s", agent, id: "call", messageID: "message", signal: new AbortController().signal, progress: async () => {} }) as unknown as ToolContext;
  for (const name of ["ssh_shell_exec", "ssh_upload_file", "ssh_download_file", "ssh_write_file", "ssh_reset_connection"]) {
    await assert.rejects(tools.get(name)!.execute({}, call("plan")), /read-only/);
    await assert.rejects(tools.get(name)!.execute({}, call("explore")), /read-only/);
  }
  deny = new Error("native permission rejected with feedback");
  await assert.rejects(tools.get("ssh_shell_exec")!.execute({ host: host.id, command: "echo ok && git push" }, call("build")), error => error === deny);
  assert.ok(checks.at(-1)?.resources.includes("git push"));
  assert.equal(performed, 0);
  deny = undefined; checks.length = 0;
  const list = await tools.get("ssh_list_hosts")!.execute({}, call("explore"));
  assert.ok(!String(list.content).includes("credentialId"));
  assert.equal(checks[0].action, "read");
  const nativeError = new Error("local external path denied");
  deny = nativeError; denyAction = "external_directory";
  const outside = path.resolve(temp.directory, `../${path.basename(temp.directory)}-outside`);
  await writeFile(outside, "fixture"); t.after(() => rm(outside, { force: true }));
  await assert.rejects(tools.get("ssh_upload_file")!.execute({ host: host.id, localPath: outside, remotePath: "x" }, call("build")), error => error === nativeError);
});
