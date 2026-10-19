import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir as localMkdir } from "node:fs/promises";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { dockerFixture } from "./docker.ts";
import { RemoteRuntime } from "../src/runtime.ts";
import { MemoryVault, temporary } from "./helpers.ts";
import * as files from "../src/files.ts";
import type { HostProfile } from "../src/domain.ts";
import type { Plugin } from "@opencode/plugin";
import type { Info, ToolContext } from "@opencode/plugin/promise/tool";
import { registerTools } from "../src/tools.ts";

describe("real Linux OpenSSH integration from the local runtime", { skip: process.env.REMOTE_SSH_INTEGRATION !== "1", timeout: 240_000 }, () => {
  let fixture: Awaited<ReturnType<typeof dockerFixture>>, temp: Awaited<ReturnType<typeof temporary>>, runtime: RemoteRuntime, host: HostProfile;
  const tokens = new Map<string, string>();
  const publish = (id: string) => async (token: string) => { tokens.set(id, token); };
  before(async () => {
    fixture = await dockerFixture(); temp = await temporary();
    runtime = new RemoteRuntime(temp.directory, new MemoryVault()); await runtime.load();
    host = await runtime.save({ name: "密码服务器", hostname: "127.0.0.1", port: fixture.target.port, username: "tester", auth: "password" }, "fixture-password", false);
  });
  after(async () => { runtime?.close(); await temp?.close(); await fixture?.close(); });

  it("password login starts at home; failed directory change preserves this host's directory", async () => {
    const workspace = await runtime.setWorkspace("a", host.id, undefined, publish("a"));
    assert.equal(workspace.directory, "/home/tester");
    await assert.rejects(runtime.setWorkspace("a", host.id, "/not-a-directory", publish("a")));
    assert.equal(runtime.resolve("a", host.id).directory, "/home/tester");
  });
  it("key and encrypted-key login work, including a mixed-auth jump chain", async () => {
    const directKey = await runtime.save({ name: "密钥服务器", hostname: "127.0.0.1", port: fixture.target.port, username: "tester", auth: "key", privateKeyPath: fixture.keyPath });
    assert.equal((await runtime.test(directKey.id)).exec, true);
    const jump = await runtime.save({ name: "密码跳板", hostname: "127.0.0.1", port: fixture.jump.port, username: "tester", auth: "password" }, "fixture-password", false);
    const viaJump = await runtime.save({ name: "跳板后的密钥主机", hostname: "target", username: "tester", auth: "key", privateKeyPath: fixture.encryptedKeyPath, jumpHostId: jump.id }, "fixture-passphrase", false);
    assert.deepEqual((await runtime.test(viaJump.id)).hops, ["密码跳板", "跳板后的密钥主机"]);
    const thirdHop = await runtime.save({ name: "第二级后的密码目标", hostname: "jump", username: "tester", auth: "password", jumpHostId: viaJump.id }, "fixture-password", false);
    assert.deepEqual((await runtime.test(thirdHop.id)).hops, ["密码跳板", "跳板后的密钥主机", "第二级后的密码目标"]);
  });
  it("streams binary files, preserves existing destinations and supports Unicode/quoted paths", async () => {
    const connection = await runtime.connection("files", host.id, true);
    const directory = "/home/tester/目录 ' with spaces";
    await files.mkdir(connection, directory, false);
    const bytes = randomBytes(8 * 1024 * 1024 + 3), local = path.join(temp.directory, "source.bin"), remote = `${directory}/数据.bin`;
    await writeFile(local, bytes);
    await files.upload(connection, local, remote, false);
    await assert.rejects(files.upload(connection, Buffer.from("wrong"), remote, false), /exists/);
    const downloaded = path.join(temp.directory, "download.bin");
    await files.download(connection, remote, downloaded, false);
    const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
    assert.equal(hash(await readFile(downloaded)), hash(bytes));
    await assert.rejects(files.download(connection, remote, downloaded, false), /exists/);
    await files.upload(connection, Buffer.from("新内容\nsecond\nthird\n"), remote, true);
    assert.equal((await files.readText(connection, remote, 2, 1)).content, "second");
    await files.download(connection, remote, downloaded, true);
    assert.equal(await readFile(downloaded, "utf8"), "新内容\nsecond\nthird\n");
    await assert.rejects(files.upload(connection, Buffer.from("x"), "/home/tester/missing/parent.txt", false), /parent/);
    const controller = new AbortController();
    await assert.rejects(files.upload(connection, local, remote, true, controller.signal, () => controller.abort()));
    assert.equal((await files.readText(connection, remote, 1, 20)).content, "新内容\nsecond\nthird");
    const entries = await files.listDirectory(connection, directory, 100);
    assert.deepEqual(entries.entries.map(item => item.name), ["数据.bin"]);
  });
  it("file search, move and explicit recursive deletion operate on the remote filesystem", async () => {
    const connection = await runtime.connection("operations", host.id, true);
    await files.mkdir(connection, "/home/tester/project/src/nested", true);
    await files.upload(connection, Buffer.from("hello\nMATCH me\n"), "/home/tester/project/src/nested/a.ts", false);
    assert.deepEqual((await files.glob(connection, "/home/tester/project", "src/**/*.ts", 50)).files, ["src/nested/a.ts"]);
    assert.equal((await files.grep(connection, "/home/tester/project", "MATCH", "*.ts", false, 50)).matches.length, 1);
    await files.move(connection, "/home/tester/project/src/nested/a.ts", "/home/tester/project/src/nested/b.ts", false);
    await assert.rejects(files.remove(connection, "/home/tester/project", false));
    await files.remove(connection, "/home/tester/project", true);
  });
  it("sessions and child directory snapshots remain isolated across parent directory changes", async () => {
    const connection = await runtime.connection("parent", host.id, true);
    await files.mkdir(connection, "/home/tester/work-a", false);
    await files.mkdir(connection, "/home/tester/work-b", false);
    await runtime.setWorkspace("parent", host.id, "/home/tester/work-a", publish("parent"));
    const inherited = tokens.get("parent");
    await runtime.setWorkspace("parent", host.id, "/home/tester/work-b", publish("parent"));
    runtime.session("child", inherited);
    assert.equal(runtime.resolve("child", host.id).directory, "/home/tester/work-a");
    await runtime.setWorkspace("child", host.id, undefined, publish("child"));
    await runtime.disconnect("parent", host.id, publish("parent"));
    await assert.rejects(runtime.connection("parent", host.id, false), /explicitly disconnected/);
    assert.equal((await (await runtime.connection("child", host.id, false)).exec("printf child")).stdout, "child");
    await runtime.setWorkspace("parent", host.id, undefined, publish("parent"));
    assert.equal(runtime.resolve("parent", host.id).directory, "/home/tester");
  });
  it("explicit host IDs support concurrent tools and independent per-host directories without a current target", async () => {
    const second = await runtime.save({ name: "并行主机", hostname: "127.0.0.1", port: fixture.jump.port, username: "tester", auth: "password" }, "fixture-password", false);
    const connections = await Promise.all([host, second].map(h => runtime.connection("multiple", h.id, true)));
    await Promise.all(connections.map((connection, index) => connection.exec(`mkdir -p /home/tester/multi-${index}`)));
    await Promise.all([host, second].map((h, index) => runtime.setWorkspace("multiple", h.id, `/home/tester/multi-${index}`, publish("multiple"))));
    runtime.session("multiple-child", tokens.get("multiple"));
    assert.equal(runtime.resolve("multiple-child", host.id).directory, "/home/tester/multi-0");
    assert.equal(runtime.resolve("multiple-child", second.id).directory, "/home/tester/multi-1");
    const tools = new Map<string, Info>();
    const context = {
      tool: { transform: async (callback: (editor: { add: (tool: Info) => void }) => void) => callback({ add: tool => { tools.set(tool.name, tool); } }) },
      session: { get: async () => ({ location: { directory: temp.directory } }) },
      permission: { assert: async () => {} },
    } as unknown as Plugin.Context;
    await registerTools(context, runtime);
    const call = { sessionID: "multiple", agent: "build", id: "call", messageID: "message", signal: new AbortController().signal, progress: async () => {} } as unknown as ToolContext;
    const exec = async (hostId: string) => JSON.parse(String((await tools.get("ssh_shell_exec")!.execute({ hostId, command: "pwd" }, call)).content));
    const [a, b] = await Promise.all([exec(host.id), exec(second.id)]);
    assert.equal(a.hostId, host.id); assert.equal(a.stdout, "/home/tester/multi-0\n");
    assert.equal(b.hostId, second.id); assert.equal(b.stdout, "/home/tester/multi-1\n");
    await runtime.setWorkspace("multiple", host.id, "/home/tester", publish("multiple"));
    assert.equal((await exec(second.id)).stdout, "/home/tester/multi-1\n");
    await runtime.disconnect("multiple", host.id, publish("multiple"));
    assert.equal((await exec(second.id)).ok, true);
    assert.equal((await exec(host.id)).code, "MANUALLY_DISCONNECTED");
    assert.equal("target" in runtime.state("multiple"), false);
    assert.ok(runtime.state("multiple").hosts.every(h => !("current" in h)));
  });
  it("timeouts and cancellation settle, do not replay commands and leave the transport usable", async () => {
    const connection = await runtime.connection("execution", host.id, true);
    const timeout = await connection.exec("printf once >> /home/tester/executions; sleep 10", { timeoutMs: 100 });
    assert.equal(timeout.timedOut, true);
    assert.equal((await connection.exec("cat /home/tester/executions")).stdout, "once");
    const controller = new AbortController();
    const pending = connection.exec("sleep 10", { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    assert.equal((await pending).cancelled, true);
    assert.equal((await connection.exec("printf alive")).stdout, "alive");
  });
  it("sudo authenticates once, separates stdin, elevates pipelines/redirection and never replays failures", async () => {
    const connection = await runtime.connection("sudo", host.id, true);
    let prompts = 0;
    const sudo = async () => { prompts++; return "fixture-password"; };
    const result = await connection.exec("cd /home/tester && cat > sudo-input; id -u | cat; cat sudo-input; pwd; printf diagnostic >&2", { sudo, stdin: "payload\n", timeoutMs: 15_000 });
    assert.equal(result.exitCode, 0); assert.equal(result.elevated, true);
    assert.equal(result.stdout, "0\npayload\n/home/tester\n");
    assert.ok(result.stderr.endsWith("diagnostic")); assert.equal(prompts, 1);
    assert.ok(!result.stderr.includes("remote-ssh-sudo-") && !result.stderr.includes("remote-ssh-root-") && !result.stderr.includes("fixture-password"));
    assert.equal((await connection.exec("stat -c %U /home/tester/sudo-input")).stdout.trim(), "root");
    const failed = await connection.exec("printf once >> /home/tester/sudo-once; exit 7", { sudo });
    assert.equal(failed.exitCode, 7); assert.equal(failed.elevated, true);
    assert.equal((await connection.exec("cat /home/tester/sudo-once")).stdout, "once");
    let attempts = 0;
    const corrected = await connection.exec("printf corrected", { sudo: async (_signal, retry) => { assert.equal(retry, attempts > 0); return ++attempts === 1 ? "wrong" : "fixture-password"; } });
    assert.equal(corrected.stdout, "corrected"); assert.equal(attempts, 2);
    const timeout = await connection.exec("printf once >> /home/tester/sudo-timeout; sleep 10", { sudo, timeoutMs: 1000 });
    assert.equal(timeout.timedOut, true);
    assert.equal((await connection.exec("cat /home/tester/sudo-timeout")).stdout, "once");
    const blocked = await connection.exec("printf must-not-run", { timeoutMs: 100, sudo: signal => new Promise(resolve => signal.addEventListener("abort", () => resolve(undefined), { once: true })) });
    assert.equal(blocked.timedOut, true); assert.equal(blocked.elevated, false); assert.equal(blocked.stdout, "");
    const nopass = await runtime.save({ name: "免密 sudo", hostname: "127.0.0.1", port: fixture.target.port, username: "nopass", auth: "password" }, "fixture-password", false);
    const privileged = await runtime.connection("sudo-nopass", nopass.id, true);
    const noPrompt = await privileged.exec("id -u; cat", { sudo: async () => { throw new Error("NOPASSWD must not request a password"); }, stdin: "input" });
    assert.equal(noPrompt.exitCode, 0); assert.equal(noPrompt.stdout, "0\ninput"); assert.equal(noPrompt.elevated, true);
  });
  it("SFTP absence does not disable SSH command execution", async () => {
    const noSftp = await runtime.save({ name: "无 SFTP", hostname: "127.0.0.1", port: fixture.noSftp.port, username: "tester", auth: "password" }, "fixture-password", false);
    const result = await runtime.test(noSftp.id);
    assert.equal(result.exec, true); assert.equal(result.sftp, false);
    const connection = await runtime.connection("no-sftp", noSftp.id, true);
    assert.equal((await connection.exec("printf working")).stdout, "working");
    await assert.rejects(files.listDirectory(connection, "/home/tester", 10), /SFTP/);
  });
  it("configuration changes preserve active connections and deletion rejects active use", async () => {
    const initial = await runtime.save({ name: "配置快照", hostname: "127.0.0.1", port: fixture.target.port, username: "tester", auth: "password" }, "fixture-password", false);
    const connection = await runtime.connection("config", initial.id, true);
    await runtime.save({ id: initial.id, name: "改名", hostname: "127.0.0.1", port: 1, username: "tester", auth: "password" });
    assert.equal((await connection.exec("printf snapshot")).stdout, "snapshot");
    assert.equal(runtime.state("config").hosts.find(h => h.host.id === initial.id)?.changed, true);
    await assert.rejects(runtime.deleteHost(initial.id), /in use/);
    await runtime.disconnect("config", initial.id, publish("config"));
    await runtime.deleteHost(initial.id);
  });
  it("unexpected transport loss restores the directory, while manual disconnect resets it", async () => {
    await runtime.setWorkspace("recovery", host.id, "/home/tester/work-a", publish("recovery"));
    const connection = await runtime.connection("recovery", host.id, false);
    connection.close();
    const recovered = await runtime.connection("recovery", host.id, false);
    assert.notEqual(recovered, connection);
    assert.equal(runtime.resolve("recovery", host.id).directory, "/home/tester/work-a");
    assert.equal((await recovered.exec("printf recovered")).stdout, "recovered");
    await runtime.reset("recovery", host.id);
    assert.equal(runtime.resolve("recovery", host.id).directory, "/home/tester/work-a");
  });
  it("restarting runtime forgets directories and temporary credentials without automatic connections", async () => {
    const reloaded = new RemoteRuntime(temp.directory, new MemoryVault()); await reloaded.load();
    try {
      reloaded.session("child", tokens.get("child"));
      assert.equal(reloaded.resolve("child", host.id).directory, undefined);
      assert.ok(reloaded.state("child").hosts.every(h => h.status === "disconnected"));
      assert.equal(await reloaded.credentials.get(host.credentialId, false), undefined);
    } finally { reloaded.close(); }
  });
});
