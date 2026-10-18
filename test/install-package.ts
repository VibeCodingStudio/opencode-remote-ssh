import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { temporary } from "./helpers.ts";

const exec = promisify(execFile);
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run using npm run test:install");
const temp = await temporary();
try {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as { name: string };
  const packed = await exec(process.execPath, [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", temp.directory], { timeout: 60_000 });
  const archive = JSON.parse(packed.stdout)[0].filename as string;
  const consumer = path.join(temp.directory, "consumer");
  await mkdir(consumer);
  await writeFile(path.join(consumer, "package.json"), JSON.stringify({
    name: "remote-ssh-clean-consumer", version: "1.0.0", private: true,
    dependencies: { [manifest.name]: `file:../${archive}` },
  }));
  try {
    await exec(process.execPath, [npmCli, "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: consumer, timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    console.error((error as { stderr?: string }).stderr ?? error);
    throw new Error("Published-package dependency resolution failed in a clean consumer");
  }
  const lock = JSON.parse(await readFile(path.join(consumer, "package-lock.json"), "utf8"));
  assert.ok(lock.packages[`node_modules/${manifest.name}`]);
  console.log("Clean-consumer packaged dependency resolution passed (without force or legacy-peer-deps).");
} finally { await temp.close(); }
