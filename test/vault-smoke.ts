import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SystemSecrets } from "../src/credentials.ts";
import { temporary } from "./helpers.ts";

if (process.platform !== "win32" && process.platform !== "darwin") {
  console.log("Native vault smoke is for Windows/macOS.");
} else {
  const temp = await temporary(), vault = new SystemSecrets(temp.directory), id = randomUUID();
  const value = `fixture-${randomUUID()}-口令`;
  try {
    await vault.set(id, value);
    assert.equal(await new SystemSecrets(temp.directory).get(id), value);
    await vault.delete(id);
    assert.equal(await vault.get(id), undefined);
    console.log(`${process.platform}: native credential store round-trip passed.`);
  } finally { await vault.delete(id).catch(() => {}); await temp.close(); }
}
