import { spawnSync } from "node:child_process";
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "test/integration.test.ts"], {
  stdio: "inherit", env: { ...process.env, REMOTE_SSH_INTEGRATION: "1" },
});
process.exitCode = result.status ?? 1;
