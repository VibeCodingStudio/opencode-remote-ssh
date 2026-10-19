import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";
import { HostInput } from "./domain.ts";

const error = { failure: z.object({ code: z.string() }) };
export const RemoteSsh = Rpc.define({
  id: "studio.remote-ssh",
  methods: {
    state: { input: z.object({ sessionId: z.string().optional() }), output: z.unknown(), errors: error },
    save: { input: z.object({ host: HostInput, secret: z.string().max(16_384).optional(), remember: z.boolean().optional() }), output: z.unknown(), errors: error },
    manage: { input: z.object({ action: z.enum(["connect", "disconnect", "test", "delete", "forget-key", "forget-sudo"]), hostId: z.string(), sessionId: z.string().optional() }), output: z.unknown(), errors: error },
    credential: { input: z.object({ requestId: z.string(), value: z.string().max(16_384).optional(), remember: z.boolean().default(false), reuseSSH: z.boolean().default(false) }), output: z.unknown(), errors: error },
  },
  events: { updated: { schema: z.object({}) } },
});
