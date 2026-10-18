import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import ssh2 from "ssh2";
import { Connector } from "../src/transport.ts";
import { HostKeys } from "../src/storage.ts";
import { temporary } from "./helpers.ts";

async function keyboardServer(prompt: string) {
  const replies: string[][] = [];
  const sockets: { end: () => void }[] = [];
  const key = ssh2.utils.generateKeyPairSync("ed25519");
  const server = new ssh2.Server({ hostKeys: [key.private] }, client => {
    sockets.push(client); client.on("error", () => {});
    client.on("authentication", context => {
      if (context.method !== "keyboard-interactive") { context.reject(["keyboard-interactive"]); return; }
      context.prompt([{ prompt, echo: false }], answers => { replies.push(answers); answers[0] === "password" ? context.accept() : context.reject(); });
    });
    client.on("ready", () => client.on("session", accept => {
      const session = accept();
      session.on("exec", accept => { const channel = accept(); channel.write("/home/tester\0"); channel.exit(0); channel.end(); });
      session.on("sftp", (_accept, reject) => reject());
    }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  return { port: address.port, replies, close: async () => { sockets.forEach(s => s.end()); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
test("single-password keyboard-interactive is supported, OTP prompts do not receive a password", async t => {
  const temp = await temporary(); t.after(temp.close);
  const keys = new HostKeys(path.join(temp.directory, "keys.json")); await keys.load();
  for (const prompt of ["Password: ", "Verification code: "]) {
    const server = await keyboardServer(prompt);
    const connector = new Connector(keys);
    try {
      const connect = connector.connect([{ id: "fixture", name: "keyboard fixture", hostname: "127.0.0.1", port: server.port, username: "tester", auth: "password", revision: 1, remembered: false }], async () => "password");
      if (prompt.startsWith("Password")) {
        const connection = await connect;
        assert.deepEqual(server.replies, [["password"]]); connection.close();
      } else {
        await assert.rejects(connect);
        assert.ok(server.replies.every(replies => !replies.includes("password")));
      }
    } finally { await server.close(); }
  }
});
