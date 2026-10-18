import assert from "node:assert/strict";
import { exec as execShell, execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { temporary } from "./helpers.ts";

const exec = promisify(execFile);
const execCommand = promisify(execShell);
if (!process.env.npm_execpath) throw new Error("Run using npm run test:tui-package");
const temp = await temporary();
try {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  const packed = await exec(process.execPath, [process.env.npm_execpath, "pack", "--ignore-scripts", "--pack-destination", temp.directory, "--json"]);
  const archive = path.join(temp.directory, JSON.parse(packed.stdout)[0].filename);
  const installed = path.join(temp.directory, "node_modules", manifest.name);
  await mkdir(installed, { recursive: true });
  await exec("tar", ["-xzf", archive, "-C", installed, "--strip-components=1"]);
  // Supply dependencies, not the development config or source transform.
  await symlink(path.resolve("node_modules"), path.join(installed, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const host = path.join(temp.directory, "installed-tui-host.mjs");
  await cp("test/installed-tui-host.mjs", host);
  const bun = process.env.REMOTE_SSH_BUN ?? (await execCommand('bun -e "console.log(process.execPath)"')).stdout.trim();
  const entrypoint = process.argv.includes("--source-entry") ? "src/tui/index.tsx" : manifest.exports["./tui"];
  try {
    const result = await exec(bun, [host], {
      cwd: temp.directory, timeout: 30_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, REMOTE_SSH_HOST_MODULES: path.resolve("node_modules"), REMOTE_SSH_PACKAGE_TUI: path.resolve(installed, entrypoint) },
    });
    assert.match(result.stdout, /Installed TUI entrypoint loaded/);
    console.log(result.stdout.trim());
  } catch (error) {
    console.error((error as { stderr?: string }).stderr ?? error);
    throw new Error("Installed TUI package failed to load/render under the host runtime");
  }
} finally { await temp.close(); }
