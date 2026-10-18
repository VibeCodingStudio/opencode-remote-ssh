import type { SFTPWrapper, Stats } from "ssh2";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat as localLstat, rename as localRename, rm as localRm, link as localLink, stat as localStat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { Minimatch } from "minimatch";
import { checkAbort, SshError } from "./domain.ts";
import type { Connection } from "./transport.ts";
import { quote } from "./paths.ts";

export function sftpCall<T>(fn: (callback: (error: Error | undefined | null, result: T) => void) => void, signal?: AbortSignal, timeoutMs = 120_000) {
  checkAbort(signal);
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (error?: Error | null, value?: T) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(value!);
    };
    const abort = () => finish(new SshError("CANCELLED", "SFTP operation cancelled; an already submitted write may have completed"));
    const timer = setTimeout(() => finish(new SshError("SFTP_TIMEOUT", "SFTP request timed out; result may be unknown")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    try { fn(finish); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    if (signal?.aborted) abort();
  });
}
export async function remoteStat(sftp: SFTPWrapper, target: string, follow = false, signal?: AbortSignal): Promise<Stats | undefined> {
  try { return await sftpCall<Stats>(cb => follow ? sftp.stat(target, cb) : sftp.lstat(target, cb), signal); }
  catch (error) { if ((error as { code?: number }).code === 2) return undefined; throw error; }
}
async function requireParent(sftp: SFTPWrapper, target: string, signal?: AbortSignal) {
  const info = await remoteStat(sftp, path.posix.dirname(target), true, signal);
  if (!info?.isDirectory()) throw new SshError("PARENT_MISSING", "Destination parent directory does not exist; use ssh_mkdir");
}
async function writable(sftp: SFTPWrapper, target: string, overwrite: boolean, signal?: AbortSignal) {
  const info = await remoteStat(sftp, target, false, signal);
  if (info && !overwrite) throw new SshError("DESTINATION_EXISTS", `Destination exists: ${target}`);
  if (info && !info.isFile()) throw new SshError("NOT_REGULAR_FILE", `Destination is not a regular file: ${target}`);
  await requireParent(sftp, target, signal);
  return info;
}
async function publish(sftp: SFTPWrapper, temp: string, target: string, overwrite: boolean, signal?: AbortSignal) {
  if (overwrite) {
    // OpenSSH's extension is atomic even when the destination exists. Never unlink first.
    try { await sftpCall<void>(cb => sftp.ext_openssh_rename(temp, target, cb), signal); return; }
    catch (error) {
      if (error instanceof SshError) throw error;
      if (!/unsupported|extension/i.test(String(error))) throw error;
      if (await remoteStat(sftp, target, false, signal)) throw new SshError("ATOMIC_REPLACE_UNAVAILABLE", "Server cannot atomically replace this file; original destination was preserved");
      if (!/unsupported|extension/i.test(String(error))) throw error;
    }
  }
  // SFTP v3 rename must fail when newpath exists; do not emulate with unlink + rename.
  await sftpCall<void>(cb => sftp.rename(temp, target, cb), signal);
}
export type Progress = (bytes: number, total?: number) => void;
function counter(progress?: Progress, total?: number) {
  let bytes = 0, last = 0;
  const stream = new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.length;
    if (Date.now() - last > 250) { last = Date.now(); progress?.(bytes, total); }
    done(null, chunk);
  } });
  return { stream, bytes: () => { progress?.(bytes, total); return bytes; } };
}
export async function upload(connection: Connection, source: string | Buffer, destination: string, overwrite: boolean, signal?: AbortSignal, progress?: Progress) {
  const sftp = await connection.sftp(signal);
  await writable(sftp, destination, overwrite, signal);
  const info = typeof source === "string" ? await localStat(source) : undefined;
  if (info && !info.isFile()) throw new SshError("NOT_REGULAR_FILE", "Upload supports a single regular file");
  const total = info?.size ?? (source as Buffer).length;
  const temp = `${destination}.opencode-${randomUUID()}.tmp`;
  const transfer = counter(progress, total);
  try {
    checkAbort(signal);
    const input = typeof source === "string" ? createReadStream(source) : Readable.from([source]);
    await pipeline(input, transfer.stream, sftp.createWriteStream(temp, { flags: "wx", mode: 0o600 }), { signal });
    checkAbort(signal);
    const existing = await writable(sftp, destination, overwrite, signal);
    if (existing) await sftpCall<void>(cb => sftp.chmod(temp, existing.mode & 0o777, cb), signal);
    await publish(sftp, temp, destination, overwrite, signal);
    return { path: destination, bytes: transfer.bytes() };
  } finally { await sftpCall<void>(cb => sftp.unlink(temp, cb), undefined, 2000).catch(() => {}); }
}
export async function download(connection: Connection, source: string, destination: string, overwrite: boolean, signal?: AbortSignal, progress?: Progress) {
  const sftp = await connection.sftp(signal);
  const info = await remoteStat(sftp, source, true, signal);
  if (!info?.isFile()) throw new SshError("NOT_REGULAR_FILE", "Download source must be a regular file");
  const existing = await localLstat(destination).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (existing && !overwrite) throw new SshError("DESTINATION_EXISTS", `Destination exists: ${destination}`);
  if (existing && !existing.isFile()) throw new SshError("NOT_REGULAR_FILE", "Local destination is not a regular file");
  if (!(await localStat(path.dirname(destination))).isDirectory()) throw new SshError("PARENT_MISSING", "Local parent directory does not exist");
  const temp = `${destination}.opencode-${randomUUID()}.tmp`;
  const transfer = counter(progress, info.size);
  try {
    await pipeline(sftp.createReadStream(source), transfer.stream, createWriteStream(temp, { flags: "wx", mode: 0o600 }), { signal });
    checkAbort(signal);
    if (overwrite) await localRename(temp, destination);
    else { await localLink(temp, destination); await localRm(temp); }
    return { path: destination, bytes: transfer.bytes() };
  } finally { await localRm(temp, { force: true }); }
}
export async function listDirectory(connection: Connection, target: string, limit: number, signal?: AbortSignal) {
  const sftp = await connection.sftp(signal);
  const handle = await sftpCall<Buffer>(cb => sftp.opendir(target, cb), signal);
  const entries: { name: string; type: string; size: number; modified: number }[] = [];
  let truncated = false;
  try {
    while (true) {
      checkAbort(signal);
      const batch = await sftpCall<false | sshListing[]>(cb => sftp.readdir(handle, cb), signal).catch(error => {
        // OpenSSH returns SSH_FX_EOF for a directory handle after its last batch.
        if ((error as { code?: number }).code === 1) return false as const;
        throw error;
      });
      if (batch === false || batch.length === 0) break;
      for (const item of batch) {
        if (item.filename === "." || item.filename === "..") continue;
        if (entries.length >= limit) { truncated = true; break; }
        entries.push({ name: item.filename, type: item.attrs.isDirectory() ? "directory" : item.attrs.isSymbolicLink() ? "symlink" : "file", size: item.attrs.size, modified: item.attrs.mtime });
      }
      if (truncated) break;
    }
  } finally { await sftpCall<void>(cb => sftp.close(handle, cb), undefined, 2000).catch(() => {}); }
  return { path: target, entries, truncated };
}
type sshListing = { filename: string; attrs: Stats };
export async function readText(connection: Connection, target: string, start: number, limit: number, signal?: AbortSignal, maxBytes = 256 * 1024) {
  const sftp = await connection.sftp(signal);
  if (!(await remoteStat(sftp, target, true, signal))?.isFile()) throw new SshError("NOT_REGULAR_FILE", "Read source must be a regular file");
  const stream = sftp.createReadStream(target);
  const abort = () => stream.destroy(new SshError("CANCELLED", "File read cancelled"));
  signal?.addEventListener("abort", abort, { once: true });
  const decoder = new StringDecoder("utf8");
  const lines: string[] = [];
  let pending = "", current = 1, outputBytes = 0, scanned = 0, truncated = false;
  const take = (line: string) => {
    if (current++ < start) return true;
    const remaining = maxBytes - outputBytes;
    if (lines.length >= limit || remaining <= 0) { truncated = true; return false; }
    const bytes = Buffer.from(line);
    if (bytes.length > remaining) { lines.push(bytes.subarray(0, remaining).toString("utf8")); truncated = true; return false; }
    lines.push(line.replace(/\r$/, "")); outputBytes += bytes.length + 1;
    return true;
  };
  try {
    checkAbort(signal);
    outer: for await (const chunk of stream) {
      checkAbort(signal);
      const bytes = Buffer.from(chunk); scanned += bytes.length;
      if (bytes.includes(0)) throw new SshError("BINARY_FILE", "Binary file; use ssh_download_file");
      if (scanned > 64 * 1024 * 1024) { truncated = true; break; }
      pending += decoder.write(bytes);
      let index: number;
      while ((index = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        if (!take(line)) break outer;
      }
      if (pending.length > maxBytes) {
        if (current >= start) { take(pending); truncated = true; break; }
        // Bounded scan: very long skipped lines cannot grow memory without limit.
        throw new SshError("LINE_TOO_LARGE", "A skipped line exceeds the text read limit");
      }
    }
    if (!truncated && pending) take(pending + decoder.end());
  } finally { signal?.removeEventListener("abort", abort); stream.destroy(); }
  return { path: target, start, lines: lines.length, content: lines.join("\n"), truncated };
}
export async function mkdir(connection: Connection, target: string, parents: boolean, signal?: AbortSignal) {
  const sftp = await connection.sftp(signal);
  const parts = parents ? target.split("/").filter(Boolean).map((_v, i, all) => "/" + all.slice(0, i + 1).join("/")) : [target];
  for (const part of parts) {
    checkAbort(signal);
    const info = await remoteStat(sftp, part, true, signal);
    if (info?.isDirectory()) continue;
    if (info) throw new SshError("DESTINATION_EXISTS", `A non-directory exists at ${part}`);
    await sftpCall<void>(cb => sftp.mkdir(part, { mode: 0o755 }, cb), signal);
  }
  return { path: target };
}
export async function remove(connection: Connection, target: string, recursive: boolean, signal?: AbortSignal) {
  const sftp = await connection.sftp(signal);
  const visit = async (item: string, depth: number): Promise<void> => {
    checkAbort(signal);
    if (depth > 128) throw new SshError("DEPTH_LIMIT", "Directory depth exceeds operation limit");
    const info = await remoteStat(sftp, item, false, signal);
    if (!info) throw new SshError("NOT_FOUND", `Remote path does not exist: ${item}`);
    if (!info.isDirectory()) { await sftpCall<void>(cb => sftp.unlink(item, cb), signal); return; }
    if (recursive) {
      const children = await listDirectory(connection, item, 100_000, signal);
      if (children.truncated) throw new SshError("DIRECTORY_TOO_LARGE", "Directory exceeds recursive operation limit");
      for (const child of children.entries) await visit(path.posix.join(item, child.name), depth + 1);
    }
    await sftpCall<void>(cb => sftp.rmdir(item, cb), signal);
  };
  await visit(target, 0);
  return { path: target };
}
export async function move(connection: Connection, source: string, destination: string, overwrite: boolean, signal?: AbortSignal) {
  const sftp = await connection.sftp(signal);
  checkAbort(signal);
  if (!await remoteStat(sftp, source, false, signal)) throw new SshError("NOT_FOUND", `Source does not exist: ${source}`);
  await requireParent(sftp, destination, signal);
  const existing = await remoteStat(sftp, destination, false, signal);
  if (existing && !overwrite) throw new SshError("DESTINATION_EXISTS", `Destination exists: ${destination}`);
  await publish(sftp, source, destination, overwrite, signal);
  return { source, destination };
}
export async function glob(connection: Connection, root: string, pattern: string, limit: number, signal?: AbortSignal) {
  const matcher = new Minimatch(pattern, { dot: true, matchBase: !pattern.includes("/") });
  const found: string[] = [], queue = [root];
  let inspected = 0, truncated = false;
  while (queue.length) {
    checkAbort(signal);
    const directory = queue.shift()!;
    const list = await listDirectory(connection, directory, 10_000, signal);
    truncated ||= list.truncated;
    for (const item of list.entries) {
      const absolute = path.posix.join(directory, item.name), relative = path.posix.relative(root, absolute);
      if (++inspected > 50_000 || found.length >= limit) { truncated = true; return { path: root, files: found, truncated }; }
      if (matcher.match(relative)) found.push(relative);
      if (item.type === "directory") queue.push(absolute);
    }
  }
  return { path: root, files: found, truncated };
}
export async function grep(connection: Connection, root: string, pattern: string, include: string | undefined, ignoreCase: boolean, limit: number, signal?: AbortSignal) {
  // grep is an existing Linux utility; no remote helper or ripgrep installation is needed.
  const command = `cd -- ${quote(root)} && grep -rInIE ${ignoreCase ? "-i " : ""}${include ? `--include=${quote(include)} ` : ""}-- ${quote(pattern)} .`;
  const result = await connection.exec(command, { signal, maxBytes: 256 * 1024 });
  if (result.outcome !== "exited" || result.timedOut || result.cancelled || (result.exitCode !== 0 && result.exitCode !== 1)) {
    throw new SshError("SEARCH_FAILED", "Remote grep failed or was interrupted", { exitCode: result.exitCode, stderr: result.stderr, outcome: result.outcome });
  }
  const all = result.stdout.split("\n").filter(Boolean);
  return { path: root, matches: all.slice(0, limit), truncated: result.truncated || all.length > limit };
}
