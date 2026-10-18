import { Plugin } from "@opencode/plugin";
import { RemoteSsh } from "./rpc.ts";
import { runtime, SNAPSHOT_KEY } from "./runtime.ts";
import { initializeSession, publisher, readonlyAgent, READ_ONLY, registerTools, type ToolName } from "./tools.ts";
import { SshError } from "./domain.ts";

// OpenCode validates RPC output as JSON before HTTP serialization (undefined is not JSON).
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

export default Plugin.define({
  id: "studio.remote-ssh",
  async setup(ctx) {
    const remote = await runtime();
    const rpc = await ctx.rpc.register(RemoteSsh, {
      state: async input => {
        if (input.sessionId) await initializeSession(ctx, remote, input.sessionId);
        return json(remote.state(input.sessionId));
      },
      save: async (input, call) => {
        try { return json(await remote.save(input.host, input.secret, input.remember)); }
        catch (error) { return call.error("failure", error instanceof Error ? error.message : "Save failed", { code: error instanceof SshError ? error.code : "SAVE_FAILED" }); }
      },
      manage: async (input, call) => {
        try {
          if (input.action === "delete") { await remote.deleteHost(input.hostId); return { ok: true }; }
          if (input.action === "forget-key") { await remote.forgetHostKey(input.hostId); return { ok: true }; }
          if (input.action === "test") return json(await remote.test(input.hostId, call.signal));
          if (!input.sessionId) throw new SshError("SESSION_REQUIRED", "Open an OpenCode session first");
          await initializeSession(ctx, remote, input.sessionId);
          if (input.action === "connect") return json(await remote.setWorkspace(input.sessionId, input.hostId, undefined, publisher(ctx, input.sessionId), call.signal));
          await remote.disconnect(input.sessionId, input.hostId, publisher(ctx, input.sessionId));
          return { ok: true };
        } catch (error) { return call.error("failure", error instanceof Error ? error.message : "SSH operation failed", { code: error instanceof SshError ? error.code : "SSH_ERROR" }); }
      },
      credential: async (input, call) => {
        try { await remote.replyCredential(input.requestId, input.value, input.remember); return { ok: true }; }
        catch (error) { return call.error("failure", error instanceof Error ? error.message : "Credential operation failed", { code: "CREDENTIAL_ERROR" }); }
      },
    });
    await registerTools(ctx, remote);
    await ctx.session.hook("context", async event => {
      await initializeSession(ctx, remote, event.sessionID);
      const target = remote.target(event.sessionID);
      if (readonlyAgent(event.agent)) for (const name of Object.keys(event.tools)) {
        if (name.startsWith("ssh_") && !READ_ONLY.has(name as ToolName)) delete event.tools[name];
      }
      event.system.push({ type: "text", text: target
        ? `Remote SSH target for this session: ${JSON.stringify(target)}. Use ssh_* tools for tasks on that host. Native local tools still operate on the local project. ssh_set_workspace changes the remote target/directory; temporary cd in ssh_shell_exec does not. Explicit host on ordinary tools does not change the default. Never request passwords in chat; the TUI credential dialog handles them. Do not automatically replay commands with unknown outcomes.`
        : "Remote SSH is available through ssh_* tools. No remote target is selected for this session. Use ssh_list_hosts then ssh_set_workspace when the user requests remote work. Never request credentials in chat; the TUI handles credential input." });
    });
    const stop = remote.onChange(() => { void rpc.events.emit("updated", {}).catch(() => {}); });
    const release = remote.retain();
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "session.created") remote.session(event.data.sessionID, event.data.metadata?.[SNAPSHOT_KEY]);
          if (event.type === "session.deleted") remote.release(event.data.sessionID);
        }
      } catch (error) { if (!controller.signal.aborted) console.error("[remote-ssh] Session event subscription ended", error instanceof Error ? error.name : "error"); }
    })();
    return () => { stop(); controller.abort(); release(); };
  },
});
