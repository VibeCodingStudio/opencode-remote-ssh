import { z } from "zod";

export const HostInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(100),
  hostname: z.string().trim().min(1).max(253).refine(v => !/[\s\0]/.test(v), "Invalid hostname"),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(256).refine(v => !/[\0\r\n]/.test(v)),
  auth: z.enum(["password", "key"]),
  privateKeyPath: z.string().optional(),
  jumpHostId: z.string().uuid().optional(),
}).strict().refine(v => v.auth !== "key" || !!v.privateKeyPath, "Private key path is required");
export type HostDraft = z.input<typeof HostInput>;
export type HostProfile = z.output<typeof HostInput> & {
  id: string;
  revision: number;
  credentialId?: string;
  remembered: boolean;
};
export const StoredHost = HostInput.safeExtend({
  id: z.string().uuid(), revision: z.number().int().positive(),
  credentialId: z.string().uuid().optional(), remembered: z.boolean(),
});
export type HostStatus = {
  host: HostProfile;
  status: "disconnected" | "connecting" | "connected" | "error";
  directory?: string;
  home?: string;
  changed: boolean;
  sftp?: boolean;
  error?: string;
};
export class SshError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: Record<string, unknown>) {
    super(message); this.name = "SshError";
  }
}
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return typeof error === "string" ? error : "Unknown error";
}
export function failure(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") return { ok: false as const, code: "CANCELLED", error: "Operation cancelled" };
  return error instanceof SshError
    ? { ok: false as const, code: error.code, error: error.message, ...error.details }
    : { ok: false as const, code: "SSH_ERROR", error: error instanceof Error ? error.message : String(error) };
}
export function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new SshError("CANCELLED", "Operation cancelled");
}
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => {});
    return result;
  }
}
