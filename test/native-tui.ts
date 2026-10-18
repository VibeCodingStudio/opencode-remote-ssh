import pty from "@lydell/node-pty";
import xterm from "@xterm/headless";
import { createRequire } from "node:module";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { temporary } from "./helpers.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
async function executable() {
  if (process.env.OPENCODE_BINARY) return process.env.OPENCODE_BINARY;
  const manifestPath = require.resolve("@opencode/cli/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  return path.resolve(path.dirname(manifestPath), manifest.bin.opencode);
}
const binary = await executable();
const temp = await temporary();
const project = path.join(temp.directory, "project");
const config = path.join(temp.directory, "config", "opencode");
const logDir = path.join(temp.directory, "data", "opencode", "log");
const discovered = path.join(config, "plugins", "remote-ssh");
await Promise.all([project, config, logDir, discovered].map(directory => mkdir(directory, { recursive: true })));
const tuiEntry = process.env.OPENCODE_TUI_ENTRY ?? path.resolve("generated/tui.js");
await writeFile(path.join(discovered, "index.ts"), `export { default } from ${JSON.stringify(pathToFileURL(path.resolve("dist/index.js")).href)};\n`);
await writeFile(path.join(discovered, "tui.ts"), `export { default } from ${JSON.stringify(pathToFileURL(tuiEntry).href)};\n`);
const serverConfig = JSON.stringify({});
const cliConfig = JSON.stringify({ highlights: false });
await writeFile(path.join(config, "opencode.json"), serverConfig);
await writeFile(path.join(config, "cli.json"), cliConfig);
const screen = new xterm.Terminal({ cols: 120, rows: 40, allowProposedApi: true });
const env: NodeJS.ProcessEnv = {
    ...process.env, TERM: "xterm-256color", HOME: temp.directory, USERPROFILE: temp.directory,
    XDG_CONFIG_HOME: path.join(temp.directory, "config"), XDG_DATA_HOME: path.join(temp.directory, "data"),
    XDG_CACHE_HOME: path.join(temp.directory, "cache"), XDG_STATE_HOME: path.join(temp.directory, "state"),
    OPENCODE_REMOTE_SSH_DATA_DIR: path.join(temp.directory, "ssh"),
    OPENCODE_CONFIG_CONTENT: serverConfig, OPENCODE_CLI_CONFIG_CONTENT: cliConfig,
};
delete env.OPENCODE_SESSION_ID;
delete env.OPENCODE_TERMINAL;
const created = await promisify(execFile)(binary, ["api", "--standalone", "session.create", "--param", `location[directory]=${project}`, "--data", JSON.stringify({ title: "Remote SSH UI verification" })], { env, cwd: project, timeout: 30_000 });
const response = JSON.parse(created.stdout);
const session = response.data ?? response;
if (!session.id) throw new Error("Native test session was not created");
const terminal = pty.spawn(binary, ["--standalone", "--log-level", "debug", "--session", session.id, project], {
  name: "xterm-256color", cols: 120, rows: 40, cwd: project, env,
});
let exited = false;
let finishExit: () => void;
const exit = new Promise<void>(resolve => { finishExit = resolve; });
let phase = "startup", done = false, pluginReady = false;
let rejectRun: (error: Error) => void;
let resolveRun: () => void;
const result = new Promise<void>((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });
const fail = (error: Error) => { if (done) return; done = true; rejectRun(error); };
let reading = false;
const logs = async () => {
  if (reading || done) return;
  reading = true;
  try {
    for (const file of await readdir(logDir).catch(() => [])) {
      if (!file.endsWith(".log")) continue;
      const text = await readFile(path.join(logDir, file), "utf8").catch(() => "");
      const error = text.split("\n").find(line => line.includes("Keymap.Provider is missing") || line.includes('message="plugin operation failed"') && line.includes("studio.remote-ssh.tui"));
      if (error) fail(new Error(`Native TUI plugin setup failed: ${error.match(/error="([^"]*)"/)?.[1] ?? error}`));
      if (text.split("\n").some(line => line.includes('message="plugin operation completed"') && line.includes("stage=setup") && line.includes("plugin=studio.remote-ssh.tui"))) {
        pluginReady = true;
        checkFrame();
      }
    }
  } finally { reading = false; }
};
// Windows directory notifications may not fire until the logger closes its file.
const logCheck = setInterval(() => { void logs(); }, 250);
const frame = () => Array.from({ length: screen.rows }, (_, row) => screen.buffer.active.getLine(row)?.translateToString(true) ?? "").join("\n");
const timeout = setTimeout(() => fail(new Error(`Native TUI timed out in ${phase}:\n${frame()}`)), 60_000);
screen.onData(reply => { if (!exited) terminal.write(reply); });
function checkFrame() {
  if (done) return;
  const plain = frame();
  if (phase === "startup" && pluginReady && /Ask anything|ctrl\+p commands/.test(plain)) {
    phase = "ready";
    setTimeout(() => { if (!done && !exited) { phase = "autocomplete"; terminal.write("/ssh"); } }, 500);
  } else if (phase === "autocomplete" && /管理\s*SSH\s*主机/.test(plain)) {
    phase = "configuration"; terminal.write("\r");
  } else if (phase === "configuration" && /SSH\s*主机配置/.test(plain) && /添加主机/.test(plain)) {
    done = true; resolveRun();
  }
}
const data = terminal.onData(chunk => screen.write(chunk, checkFrame));
terminal.onExit(event => { exited = true; finishExit(); if (!done) fail(new Error(`Native TUI exited before /ssh opened (${event.exitCode})`)); });
let succeeded = false;
try {
  await result;
  succeeded = true;
  console.log("Native OpenCode TUI started and /ssh opened its configuration dialog (no model calls).");
} finally {
  clearTimeout(timeout); clearInterval(logCheck); data.dispose(); screen.dispose();
  if (!exited) { try { terminal.kill(); } catch {} }
  await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 2000))]);
  if (succeeded) await temp.close();
  else console.error(`Native TUI diagnostic directory: ${temp.directory}`);
}
