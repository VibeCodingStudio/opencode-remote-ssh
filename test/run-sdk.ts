import { temporary } from "./helpers.ts";
import { spawnSync } from "node:child_process";

// SDK native handles may stay open until process exit on Windows. The parent owns cleanup.
const temp = await temporary();
try {
  const result = spawnSync(process.execPath, ["test/sdk-smoke.ts"], {
    stdio: "inherit", timeout: 90_000,
    env: { ...process.env, REMOTE_SSH_SMOKE_DIR: temp.directory },
  });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
} finally { await temp.close(); }
