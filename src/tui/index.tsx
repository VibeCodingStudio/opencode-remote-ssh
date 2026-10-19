import { Plugin } from "@opencode/plugin/tui";
import { For, Show, createEffect, createRoot, createSignal } from "solid-js";
import { RemoteSsh } from "../rpc.ts";
import type { HostDraft, HostProfile, HostStatus } from "../domain.ts";
import { errorText } from "../domain.ts";
import type { StateView } from "../runtime.ts";
import { passwordDialog } from "./password.tsx";

export default Plugin.define({
  id: "studio.remote-ssh.tui",
  setup(context) {
    const controls = createRoot(dispose => {
      const api = context.client.rpc(RemoteSsh);
      const rpcOptions = () => ({ location: context.location ?? context.data.location.default() });
      const [view, setView] = createSignal<StateView>({ hosts: [], requests: [] });
      const [viewSession, setViewSession] = createSignal<string>();
      const [loadError, setLoadError] = createSignal<string>();
      let requestSequence = 0, disposed = false, editing = false, prompting = false;
      let promptRequest: string | undefined;
      const activeSession = () => { const route = context.ui.router.current(); return route.type === "session" ? route.sessionID : undefined; };
      const message = errorText;
      const notify = (text: string, error = false) => context.ui.toast.show({ title: "Remote SSH", message: text, variant: error ? "error" : "success" });
      const refresh = async () => {
        const sequence = ++requestSequence, sessionId = activeSession();
        try {
          const state = await api.state({ sessionId }, rpcOptions()) as StateView;
          if (disposed || sequence !== requestSequence) return;
          setView(state); setViewSession(sessionId); setLoadError(undefined);
          if (prompting && promptRequest && !state.requests.some(request => request.id === promptRequest)) context.ui.dialog.clear();
          void promptCredentials();
        } catch (error) { if (!disposed && sequence === requestSequence) setLoadError(message(error)); }
      };
      const run = async (action: () => Promise<unknown>) => {
        try { return await action(); } catch (error) { notify(message(error), true); return undefined; }
        finally { await refresh(); }
      };
      async function promptCredentials() {
        if (prompting || editing || disposed) return;
        const request = view().requests[0];
        if (!request) return;
        if (context.data.session.permission.list(request.sessionId)?.length) return;
        prompting = true;
        promptRequest = request.id;
        try {
          let reuseSSH = false;
          if (request.kind === "sudo" && request.canReuseSSH) {
            const source = await context.ui.dialog.select({ title: `${request.hostName} · sudo 密码`, options: [
              { title: "使用此主机的 SSH 密码", value: "ssh" },
              { title: "输入独立的 sudo 密码", value: "manual" },
            ] });
            if (!source) { await api.credential({ requestId: request.id, remember: false }, rpcOptions()); return; }
            reuseSSH = source === "ssh";
          }
          const label = request.kind === "sudo" ? `sudo 密码${request.retry ? "（上次认证失败）" : ""}` : request.kind === "password" ? "SSH 密码" : "私钥口令";
          const value = reuseSSH ? undefined : await passwordDialog(context, `${request.hostName} · ${label}`);
          if (value === undefined && !reuseSSH) { await api.credential({ requestId: request.id, remember: false }, rpcOptions()); return; }
          const remember = await context.ui.dialog.confirm({ title: "记住凭据？", message: "保存在本机系统凭据存储中；选择不记住时只保留在后台服务进程内。", label: { confirm: "记住", cancel: "仅本次运行" } });
          try { await api.credential({ requestId: request.id, value, reuseSSH, remember: remember === true }, rpcOptions()); }
          catch (error) {
            const temporary = await context.ui.dialog.confirm({ title: "凭据保存失败", message: `${message(error)}\n是否仅本次运行使用？`, label: { confirm: "仅本次", cancel: "取消" } });
            await api.credential({ requestId: request.id, value: temporary ? value : undefined, reuseSSH: temporary === true && reuseSSH, remember: false }, rpcOptions());
          }
        } catch (error) { notify(message(error), true); }
        finally { prompting = false; promptRequest = undefined; void refresh(); }
      }
      const test = (hostId: string) => run(async () => {
        notify("正在测试 SSH 和 SFTP…");
        const result = await api.manage({ action: "test", hostId }, rpcOptions()) as { home: string; sftp: boolean; hops: string[] };
        await context.ui.dialog.alert({ title: "连接测试", message: `SSH 命令：可用\nSFTP：${result.sftp ? "可用" : "不可用"}\n家目录：${result.home}\n跳转链：${result.hops.join(" → ")}` });
      });
      async function hostMenu(status: HostStatus, sessionId: string) {
        if (prompting) return;
        const action = await context.ui.dialog.select({ title: status.host.name, options: [
          { title: "连接", value: "connect" as const },
          { title: "测试连接", value: "test" as const },
          { title: "断开连接", value: "disconnect" as const },
        ] });
        if (!action) return;
        if (action === "test") { await test(status.host.id); return; }
        await run(() => api.manage({ action, hostId: status.host.id, sessionId }, rpcOptions()));
      }
      async function editor(existing?: HostProfile) {
        editing = true;
        let secret: string | undefined;
        const draft: HostDraft = existing ? {
          id: existing.id, name: existing.name, hostname: existing.hostname, port: existing.port,
          username: existing.username, auth: existing.auth, privateKeyPath: existing.privateKeyPath, jumpHostId: existing.jumpHostId,
        } : { name: "", hostname: "", port: 22, username: "", auth: "password" };
        let remember = existing?.remembered ?? false;
        let current: string | undefined;
        try {
          while (!disposed) {
            const selected = await context.ui.dialog.select({ title: existing ? `编辑 · ${draft.name}` : "添加 SSH 主机", current, options: [
              { title: `名称：${draft.name || "未填写"}`, value: "name" },
              { title: `地址：${draft.hostname || "未填写"}`, value: "hostname" },
              { title: `端口：${draft.port}`, value: "port" },
              { title: `用户名：${draft.username || "未填写"}`, value: "username" },
              { title: `认证：${draft.auth === "password" ? "密码" : "私钥"}`, value: "auth" },
              ...(draft.auth === "key" ? [{ title: `私钥文件：${draft.privateKeyPath || "未填写"}`, value: "privateKeyPath" }] : []),
              { title: `${draft.auth === "password" ? "密码" : "私钥口令（可选）"}：${secret !== undefined ? "已更新" : existing?.credentialId ? "已配置" : "未设置"}`, value: "secret" },
              { title: `记住凭据：${remember ? "是" : "否（后台进程内）"}`, value: "remember" },
              { title: `跳板机：${view().hosts.find(h => h.host.id === draft.jumpHostId)?.host.name ?? "无"}`, value: "jump" },
              { title: "保存", value: "save" },
            ] });
            if (!selected) return;
            current = selected;
            if (selected === "save") {
              try { await api.save({ host: draft, secret, remember }, rpcOptions()); notify("主机配置已保存"); return; }
              catch (error) { notify(message(error), true); continue; }
            }
            if (selected === "secret") { const entered = await passwordDialog(context, draft.auth === "password" ? "SSH 密码" : "私钥口令"); if (entered !== undefined) secret = entered; continue; }
            if (selected === "remember") { remember = !remember; continue; }
            if (selected === "auth") {
              const auth = await context.ui.dialog.select({ title: "认证方式", current: draft.auth, options: [{ title: "密码", value: "password" as const }, { title: "私钥", value: "key" as const }] });
              if (auth) { if (auth !== draft.auth) secret = undefined; draft.auth = auth; }
              continue;
            }
            if (selected === "jump") {
              const jump = await context.ui.dialog.select({ title: "选择跳板机（可以继续引用其他跳板机）", current: draft.jumpHostId ?? "", options: [
                { title: "无跳板机", value: "" },
                ...view().hosts.filter(h => h.host.id !== draft.id).map(h => ({ title: h.host.name, value: h.host.id })),
              ] });
              if (jump !== undefined) draft.jumpHostId = jump || undefined;
              continue;
            }
            const field = selected as "name" | "hostname" | "username" | "port" | "privateKeyPath";
            const value = await context.ui.dialog.prompt({ title: selected, value: String(draft[field] ?? "") });
            if (value !== undefined) {
              if (field === "port") { const port = Number(value); if (!Number.isInteger(port) || port < 1 || port > 65535) notify("端口必须为 1–65535", true); else draft.port = port; }
              else draft[field] = value;
            }
          }
        } finally { secret = undefined; editing = false; await refresh(); }
      }
      async function configure() {
        if (prompting || editing) return;
        await refresh();
        if (loadError()) { await context.ui.dialog.alert({ title: "SSH 服务不可用", message: `${loadError()}\n请确认服务端已加载插件；必要时重启 OpenCode 服务。` }); return; }
        let current: string | undefined;
        const actions = new Map<string, string>();
        while (!disposed) {
          if (current !== "new" && !view().hosts.some(({ host }) => host.id === current)) current = undefined;
          const id = await context.ui.dialog.select({ title: "SSH 主机配置", current, options: [
            { title: "＋ 添加主机", value: "new" },
            ...view().hosts.map(({ host }) => ({ title: host.name, description: `${host.username}@${host.hostname}:${host.port}`, value: host.id })),
          ] });
          if (!id) return;
          current = id;
          if (id === "new") { await editor(); continue; }
          const host = view().hosts.find(h => h.host.id === id)?.host;
          if (!host) continue;
          const action = await context.ui.dialog.select({ title: host.name, current: actions.get(id), options: [
            { title: "编辑配置", value: "edit" }, { title: "测试连接", value: "test" },
            { title: "删除配置", value: "delete" }, { title: "重置信任指纹", value: "forget-key" },
            { title: "清除 sudo 凭据", value: "forget-sudo" },
          ] });
          if (action) actions.set(id, action);
          if (action === "edit") await editor(host);
          if (action === "test") await test(id);
          if (action === "forget-sudo") {
            const yes = await context.ui.dialog.confirm({ title: "清除 sudo 凭据", message: "清除此主机在插件中的 sudo 密码缓存及已记住的密码；下次需要密码时重新询问。" });
            if (yes) await run(() => api.manage({ action, hostId: id }, rpcOptions()));
          }
          if (action === "delete" || action === "forget-key") {
            const yes = await context.ui.dialog.confirm({ title: action === "delete" ? "删除主机配置" : "重置信任指纹", message: action === "delete" ? `删除“${host.name}”？` : `重置后，下次连接会重新记录 ${host.hostname}:${host.port} 的服务器指纹。` });
            if (yes) await run(() => api.manage({ action, hostId: id }, rpcOptions()));
          }
          await refresh();
        }
      }
      context.ui.slot({ append: "sidebar.content", render: props => <box flexDirection="column" gap={1} paddingTop={1}>
        <text fg={context.theme.text.base}>远程 SSH</text>
        <Show when={loadError()}><text fg={context.theme.text.feedback.error.base}>SSH 服务暂不可用</text></Show>
        <Show when={view().hosts.length} fallback={<text fg={context.theme.text.muted}>使用 /ssh 添加主机</text>}>
          <For each={view().hosts}>{status => <box flexDirection="column" onMouseUp={() => { void run(() => hostMenu(status, props.sessionID)); }}>
            <text fg={status.status === "error" ? context.theme.text.feedback.error.base : context.theme.text.base}>
              {status.status === "connected" ? "●" : status.status === "connecting" ? "◌" : "○"} {status.host.name}
            </text>
            <text fg={context.theme.text.muted}>
              {viewSession() === props.sessionID && status.directory ? `  ${status.directory === status.home ? "~" : status.directory}` : status.status === "connecting" ? "  连接中…" : "  未连接"}
            </text>
            <Show when={status.changed}><text fg={context.theme.text.muted}>  配置已修改，重连后生效</text></Show>
            <Show when={status.error}><text fg={context.theme.text.feedback.error.base}>  {status.error}</text></Show>
          </box>}</For>
        </Show>
      </box> });
      createEffect(() => { activeSession(); void refresh(); });
      const unsubscribe = api.events.on("updated", () => { void refresh(); });
      // Events are live-only; polling also repairs state after server reconnects.
      const timer = setInterval(() => { void refresh(); }, 2000);
      return {
        configure: () => { void run(configure); },
        dispose: () => { disposed = true; clearInterval(timer); unsubscribe(); dispose(); },
      };
    });
    // Register at setup scope so OpenCode can use its captured provider owner.
    // A detached createRoot would override that fallback with an empty context.
    try {
      context.keymap.layer(() => ({ mode: "global", commands: [{
        id: "remote-ssh.configure", title: "Manage SSH hosts", group: "Remote SSH", palette: true,
        slash: { name: "ssh" }, run: controls.configure,
      }] }));
    } catch (error) { controls.dispose(); throw error; }
    return controls.dispose;
  },
});
