import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { temporary } from "./helpers.ts";

const exec = promisify(execFile);
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run using npm run test:install");
const temp = await temporary();
try {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as { name: string };
  const repository = path.join(temp.directory, "git-package");
  await mkdir(repository);
  await writeFile(path.join(repository, "package.json"), JSON.stringify(manifest));
  await cp("src", path.join(repository, "src"), { recursive: true });
  await exec("git", ["init", "--quiet", repository]);
  await exec("git", ["-C", repository, "add", "."]);
  await exec("git", ["-C", repository, "-c", "user.name=Install fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Source-only plugin fixture"]);
  // Embedded installers cannot assume that an npm build subprocess is available.
  // Exercise the actual Git fetcher; fail if the manifest triggers preparation.
  const trap = path.join(temp.directory, "unexpected-prepare.js");
  await writeFile(trap, "process.stderr.write('Unexpected Git dependency preparation'); process.exit(91);\n");
  const require = createRequire(import.meta.url);
  const pacote: { tarball(spec: string, options: Record<string, unknown>): Promise<Buffer> } = require("pacote");
  const gitArchive = await pacote.tarball(`git+${pathToFileURL(repository).href}`, {
    cache: path.join(temp.directory, "git-cache"), ignoreScripts: true,
    npmBin: trap, Arborist: require("@npmcli/arborist"),
  });
  assert.ok(gitArchive.length > 0);
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
  console.log("Source-only Git packaging and clean-consumer dependency resolution passed.");
} finally { await temp.close(); }
