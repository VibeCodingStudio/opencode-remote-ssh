import path from "node:path";
import { homedir } from "node:os";
import { SshError } from "./domain.ts";

export function localPath(value: string, base = process.cwd()) {
  if (value.includes("\0")) throw new SshError("INVALID_PATH", "Path contains NUL");
  if (value === "~") return homedir();
  if (/^~[/\\]/.test(value)) return path.resolve(homedir(), value.slice(2));
  return path.resolve(base, value);
}
export function remotePath(value: string | undefined, directory: string, home: string) {
  const input = value ?? ".";
  if (input.includes("\0")) throw new SshError("INVALID_PATH", "Path contains NUL");
  if (input.startsWith("~") && input !== "~" && !input.startsWith("~/")) {
    throw new SshError("INVALID_PATH", "Only ~ and ~/ are supported; ~other-user is not expanded");
  }
  return path.posix.resolve(directory, input === "~" ? home : input.startsWith("~/") ? `${home}/${input.slice(2)}` : input);
}
export function quote(value: string) {
  if (value.includes("\0")) throw new SshError("INVALID_ARGUMENT", "Argument contains NUL");
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function dataDirectory() {
  return process.env.OPENCODE_REMOTE_SSH_DATA_DIR
    ? path.resolve(process.env.OPENCODE_REMOTE_SSH_DATA_DIR)
    : path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "opencode-remote-ssh");
}
