import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import ssh2 from "ssh2";
import { temporary } from "./helpers.ts";

const exec = promisify(execFile);
export async function dockerFixture() {
  const temp = await temporary();
  const network = `oc-ssh-${randomUUID().slice(0, 12)}`, image = "opencode-remote-ssh-test:local";
  const containers: string[] = [];
  const docker = async (...args: string[]) => (await exec("docker", args, { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  const key = ssh2.utils.generateKeyPairSync("ed25519");
  const encrypted = ssh2.utils.generateKeyPairSync("ed25519", { passphrase: "fixture-passphrase", cipher: "aes256-cbc", rounds: 16 });
  await writeFile(path.join(temp.directory, "authorized_keys"), `${key.public}\n${encrypted.public}\n`);
  await writeFile(path.join(temp.directory, "id_ed25519"), key.private, { mode: 0o600 });
  await writeFile(path.join(temp.directory, "id_encrypted"), encrypted.private, { mode: 0o600 });
  const close = async () => {
    await Promise.all(containers.map(name => docker("rm", "-f", name).catch(() => {})));
    await docker("network", "rm", network).catch(() => {}); await temp.close();
  };
  try {
    await docker("build", "-t", image, "test/fixture");
    await docker("network", "create", network);
    const start = async (alias: string, noSftp = false) => {
      const name = `${network}-${alias}`; containers.push(name);
      await docker("run", "-d", "--rm", "--name", name, "--network", network, "--network-alias", alias,
        "-p", "127.0.0.1::22", "-v", `${temp.directory}:/keys:ro`, "-e", `NO_SFTP=${noSftp ? 1 : 0}`, image);
      const inspect = JSON.parse(await docker("inspect", name));
      const port = Number(inspect[0].NetworkSettings.Ports["22/tcp"][0].HostPort);
      // Bounded readiness probe, not a fixed sleep or external job poll.
      const deadline = Date.now() + 20_000;
      let ready = false;
      while (Date.now() < deadline && !ready) {
        ready = await new Promise<boolean>(resolve => {
          const socket = createConnection({ host: "127.0.0.1", port });
          let done = false;
          const finish = (value: boolean) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(value); };
          const timer = setTimeout(() => finish(false), 1000);
          socket.once("data", data => finish(data.toString().startsWith("SSH-")));
          socket.once("error", () => finish(false)); socket.once("close", () => finish(false));
        });
        if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!ready) throw new Error(`SSH fixture ${alias} not ready`);
      return { port, name };
    };
    const target = await start("target"), jump = await start("jump"), noSftp = await start("no-sftp", true);
    return { directory: temp.directory, keyPath: path.join(temp.directory, "id_ed25519"), encryptedKeyPath: path.join(temp.directory, "id_encrypted"), target, jump, noSftp, close, docker };
  } catch (error) { await close(); throw error; }
}
