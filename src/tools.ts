import { z } from "zod";
import type { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import type { RemoteRuntime } from "./runtime.ts";
import { SNAPSHOT_KEY } from "./runtime.ts";
import { failure, SshError } from "./domain.ts";
import { localPath, remotePath, quote } from "./paths.ts";
import * as files from "./files.ts";
import { shellResources, outsideDirectory } from "./authorization.ts";
import { realpath } from "node:fs/promises";
import nodePath from "node:path";

const hostId = z.string().uuid().describe("Required host ID from ssh_list_hosts; every operation explicitly identifies its host");
const remote = z.string().optional().describe("Remote path; relative to the session's directory on this host");
const limit = (value: number, max: number) => z.number().int().min(1).max(max).default(value);
const common = { hostId };
export const schemas = {
  ssh_list_hosts: z.object({}).strict(),
  ssh_set_workspace: z.object({ ...common, path: remote }).strict(),
  ssh_shell_exec: z.object({ ...common, command: z.string().min(1).refine(v => !v.includes("\0")), sudo: z.boolean().default(false).describe("Run the entire command as root via sudo; credentials are requested in the TUI, never include passwords in command or stdin"), stdin: z.string().optional(), timeoutMs: z.number().int().min(0).max(2_147_483_647).default(120_000) }).strict(),
  ssh_list_directory: z.object({ ...common, path: remote, limit: limit(500, 5000) }).strict(),
  ssh_read_file: z.object({ ...common, path: z.string().min(1), startLine: limit(1, 10_000_000), limit: limit(2000, 10_000) }).strict(),
  ssh_write_file: z.object({ ...common, path: z.string().min(1), content: z.string().max(4 * 1024 * 1024), overwrite: z.boolean().default(false) }).strict(),
  ssh_grep: z.object({ ...common, path: remote, pattern: z.string().min(1).max(8192), include: z.string().optional(), ignoreCase: z.boolean().default(false), limit: limit(200, 2000) }).strict(),
  ssh_glob: z.object({ ...common, path: remote, pattern: z.string().min(1).max(8192), limit: limit(500, 5000) }).strict(),
  ssh_mkdir: z.object({ ...common, path: z.string().min(1), parents: z.boolean().default(false) }).strict(),
  ssh_delete: z.object({ ...common, path: z.string().min(1), recursive: z.boolean().default(false) }).strict(),
  ssh_move: z.object({ ...common, source: z.string().min(1), destination: z.string().min(1), overwrite: z.boolean().default(false) }).strict(),
  ssh_upload_file: z.object({ ...common, localPath: z.string().min(1), remotePath: z.string().min(1), overwrite: z.boolean().default(false) }).strict(),
  ssh_download_file: z.object({ ...common, remotePath: z.string().min(1), localPath: z.string().min(1), overwrite: z.boolean().default(false) }).strict(),
  ssh_reset_connection: z.object({ ...common }).strict(),
};
export type ToolName = keyof typeof schemas;
export const READ_ONLY = new Set<ToolName>(["ssh_list_hosts", "ssh_set_workspace", "ssh_list_directory", "ssh_read_file", "ssh_grep", "ssh_glob"]);
export function readonlyAgent(agent: string) { return agent.toLowerCase() === "plan" || agent.toLowerCase() === "explore"; }
const descriptions: Record<ToolName, string> = {
  ssh_list_hosts: "列出已保存 SSH 主机及 ID、本会话中每台主机的连接状态和工作目录，不返回凭据。其他 ssh_* 工具必须显式传入 hostId；不存在当前目标。",
  ssh_set_workspace: "修改指定 hostId 在本会话中的远程工作目录。新连接从 ~ 开始；校验成功后更新该主机的目录及侧栏，不影响其他主机。可显式重连已主动断开的主机。",
  ssh_shell_exec: "在指定 hostId 的远程工作目录执行命令，返回 stdout/stderr/exitCode。sudo:true 将整个命令以 root 执行，密码通过 TUI 获取；不得把密码放进 command/stdin。默认超时120秒，0禁用超时。临时cd不改变持久工作目录。断线结果未知时不得自动重放。",
  ssh_list_directory: "列出远程目录。省略path使用当前工作目录，返回截断标记。Requires SFTP.",
  ssh_read_file: "按行读取远程文本文件。二进制文件使用ssh_download_file，输出有界。Requires SFTP.",
  ssh_write_file: "写入远程文本文件。覆盖须overwrite:true，父目录必须存在。先上传临时文件再发布。Requires SFTP.",
  ssh_grep: "在远程目录递归搜索内容，pattern使用grep扩展正则；include过滤文件名。使用远端已有grep，不安装程序。",
  ssh_glob: "在远程目录按glob匹配相对路径或文件名，支持**；不遍历目录符号链接，结果有界。Requires SFTP.",
  ssh_mkdir: "创建远程目录。parents:true允许创建多级父目录。Requires SFTP.",
  ssh_delete: "删除远程文件或目录。删除非空目录必须recursive:true，不递归跟随符号链接。Requires SFTP.",
  ssh_move: "移动/重命名远程路径；destination是精确目标路径，已存在时需要overwrite:true。Requires SFTP.",
  ssh_upload_file: "流式上传单个本地文件（包括二进制）到远程精确路径。localPath相对本地会话目录，remotePath相对远程工作目录。覆盖须overwrite:true。Requires SFTP.",
  ssh_download_file: "流式下载单个远程文件到本地精确路径。remotePath相对远程工作目录，localPath相对本地会话目录。覆盖须overwrite:true。Requires SFTP.",
  ssh_reset_connection: "只重建指定 hostId 在本会话中的异常SSH连接，保留并校验该主机的工作目录。不能保证杀死远端进程，不重放命令；主动断开的主机用ssh_set_workspace重连。",
};
export async function initializeSession(ctx: Plugin.Context, runtime: RemoteRuntime, sessionId: string) {
  const session = await ctx.session.get({ sessionID: sessionId });
  runtime.session(sessionId, session.metadata?.[SNAPSHOT_KEY]);
  return session;
}
export function publisher(ctx: Plugin.Context, sessionId: string) {
  return async (token: string) => {
    const session = await ctx.session.get({ sessionID: sessionId });
    await ctx.session.update({ sessionID: sessionId, metadata: { ...session.metadata, [SNAPSHOT_KEY]: token } });
  };
}
const content = (value: unknown) => ({ content: JSON.stringify(value) });
type Args = Record<string, any>;
export async function registerTools(ctx: Plugin.Context, runtime: RemoteRuntime) {
  await ctx.tool.transform(editor => {
    for (const name of Object.keys(schemas) as ToolName[]) editor.add({
      name, description: descriptions[name], input: schemas[name], options: { codemode: false, permission: READ_ONLY.has(name) ? "read" : name === "ssh_shell_exec" ? "shell" : "edit" },
      execute: async (input: unknown, call: ToolContext) => {
        if (readonlyAgent(call.agent) && !READ_ONLY.has(name)) throw new ToolError({ message: "This SSH tool is unavailable to a read-only agent" });
        const args = schemas[name].parse(input) as Args;
        const session = await initializeSession(ctx, runtime, call.sessionID);
        const assert = (action: string, resources: string[]) => ctx.permission.assert({
          sessionID: call.sessionID, agent: call.agent, action, resources,
          source: { type: "tool", messageID: call.messageID, id: call.id },
        });
        if (name === "ssh_list_hosts") {
          await assert("read", ["ssh://hosts"]);
          const state = runtime.state(call.sessionID);
          return content({ ok: true, hosts: state.hosts.map(({ host, ...status }) => ({ id: host.id, name: host.name, hostname: host.hostname, port: host.port, username: host.username, auth: host.auth, jumpHostId: host.jumpHostId, ...status })) });
        }
        if (name === "ssh_reset_connection") {
          let selected;
          try { selected = runtime.resolve(call.sessionID, args.hostId); } catch (error) { return content(failure(error)); }
          await assert("edit", [`ssh://${selected.host.id}/`]);
          try { return content({ ok: true, ...await runtime.reset(call.sessionID, selected.host.id, call.signal) }); }
          catch (error) { return content(failure(error)); }
        }
        let prepared;
        try {
          const selected = runtime.resolve(call.sessionID, args.hostId);
          // Capture this host's directory before asynchronous permission/connection work.
          const connection = await runtime.connection(call.sessionID, selected.host.id, name === "ssh_set_workspace", call.signal);
          const directory = selected.directory ?? connection.home;
          const resolve = (value?: string) => remotePath(value, directory, connection.home);
          prepared = { ...selected, connection, directory, resolve };
        } catch (error) { return content(failure(error)); }
        const { host, connection, directory, resolve } = prepared;
        const path = resolve(args.path);
        const uri = (value: string) => `ssh://${host.id}${value}`;
        const read = (value: string) => assert("read", [uri(value), value]);
        const edit = (value: string) => assert("edit", [uri(value), value]);
        const local = async (action: string, value: string) => {
          const absolute = localPath(value, session.location.directory);
          const canonical = action === "read" ? await realpath(absolute) : nodePath.join(await realpath(nodePath.dirname(absolute)), nodePath.basename(absolute));
          if (outsideDirectory(canonical, session.location.directory)) await assert("external_directory", [canonical]);
          await assert(action, [...new Set([absolute, canonical])]);
        };
        // Permission rejections deliberately propagate unchanged through OpenCode.
        switch (name) {
          case "ssh_set_workspace": case "ssh_list_directory": case "ssh_read_file": case "ssh_grep": case "ssh_glob": await read(path); break;
          case "ssh_shell_exec":
            await assert("shell", shellResources(args.command));
            if (args.sudo) await assert("shell", [`sudo -u root -- sh -c ${quote(args.command)}`]);
            break;
          case "ssh_move": await edit(resolve(args.source)); await edit(resolve(args.destination)); break;
          case "ssh_upload_file": await local("read", args.localPath); await edit(resolve(args.remotePath)); break;
          case "ssh_download_file": await read(resolve(args.remotePath)); await local("edit", args.localPath); break;
          default: await edit(path);
        }
        const progress = (bytes: number, total?: number) => { void call.progress({ status: "transferring", bytes, total }).catch(() => {}); };
        try {
          let result: unknown;
          switch (name) {
            case "ssh_set_workspace": result = await runtime.setWorkspace(call.sessionID, host.id, path, publisher(ctx, call.sessionID), call.signal); break;
            case "ssh_shell_exec": {
              const command = `cd -- ${quote(directory)} || exit $?\n${args.command}`;
              const options = { signal: call.signal, stdin: args.stdin, timeoutMs: args.timeoutMs };
              const output = args.sudo ? await runtime.execSudo(call.sessionID, connection, command, options) : await connection.exec(command, options);
              return content({ ok: output.exitCode === 0 && output.outcome === "exited" && !output.timedOut && !output.cancelled, hostId: host.id, directory, ...output });
            }
            case "ssh_list_directory": result = await files.listDirectory(connection, path, args.limit, call.signal); break;
            case "ssh_read_file": result = await files.readText(connection, path, args.startLine, args.limit, call.signal); break;
            case "ssh_write_file": result = await files.upload(connection, Buffer.from(args.content), path, args.overwrite, call.signal); break;
            case "ssh_grep": result = await files.grep(connection, path, args.pattern, args.include, args.ignoreCase, args.limit, call.signal); break;
            case "ssh_glob": result = await files.glob(connection, path, args.pattern, args.limit, call.signal); break;
            case "ssh_mkdir": result = await files.mkdir(connection, path, args.parents, call.signal); break;
            case "ssh_delete": result = await files.remove(connection, path, args.recursive, call.signal); break;
            case "ssh_move": result = await files.move(connection, resolve(args.source), resolve(args.destination), args.overwrite, call.signal); break;
            case "ssh_upload_file": result = await files.upload(connection, localPath(args.localPath, session.location.directory), resolve(args.remotePath), args.overwrite, call.signal, progress); break;
            case "ssh_download_file": result = await files.download(connection, resolve(args.remotePath), localPath(args.localPath, session.location.directory), args.overwrite, call.signal, progress); break;
          }
          return content({ ok: true, hostId: host.id, directory, ...result as object });
        } catch (error) { return content(failure(error)); }
      },
    });
  });
}
