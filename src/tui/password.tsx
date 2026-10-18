import type { Plugin } from "@opencode/plugin/tui";
import { createSignal, onCleanup } from "solid-js";
import type { KeyEvent, PasteEvent } from "@opentui/core";

/** Secret characters never enter an input renderable, prompt history, or durable TUI state. */
export function passwordDialog(context: Plugin.Context, title: string): Promise<string | undefined> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (value?: string) => { if (settled) return; settled = true; resolve(value); context.ui.dialog.clear(); };
    context.ui.dialog.show(() => <PasswordInput context={context} title={title} finish={finish} />, () => finish());
  });
}
export function editSecret(secret: string, action: "append" | "backspace", text = "") {
  if (action === "append") return secret + text;
  const parts = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(secret)];
  return parts.length ? secret.slice(0, parts[parts.length - 1].index) : secret;
}
function PasswordInput(props: { context: Plugin.Context; title: string; finish: (value?: string) => void }) {
  let secret = "";
  const [length, setLength] = createSignal(0);
  const pop = props.context.keymap.mode.push("remote-ssh-secret");
  onCleanup(() => { secret = ""; pop(); });
  const change = (value: string) => { secret = value; setLength([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(secret)].length); };
  const append = (value: string) => {
    if (/[\0\r\n]/.test(value) || Buffer.byteLength(secret + value) > 16_384) {
      props.context.ui.toast.show({ message: "请输入单行凭据（最多 16 KiB）", variant: "error" }); return;
    }
    change(editSecret(secret, "append", value));
  };
  const key = (event: KeyEvent) => {
    event.preventDefault(); event.stopPropagation();
    if (event.name === "escape" || event.ctrl && event.name === "c") { props.finish(); return; }
    if (event.name === "return" || event.name === "enter") { const value = secret; secret = ""; props.finish(value); return; }
    if (event.name === "backspace") { change(editSecret(secret, "backspace")); return; }
    if (event.ctrl && event.name === "u") { change(""); return; }
    if (!event.ctrl && !event.meta && event.sequence && !/[\x00-\x1f\x7f]/.test(event.sequence)) append(event.sequence);
  };
  const paste = (event: PasteEvent) => { event.preventDefault(); event.stopPropagation(); append(new TextDecoder().decode(event.bytes)); };
  return <box flexDirection="column" padding={1} gap={1} focusable focused onKeyDown={key} onPaste={paste}>
    <text fg={props.context.theme.text.base}>{props.title}</text>
    <text fg={props.context.theme.text.base}>{"●".repeat(Math.min(length(), 60)) || "输入密码或私钥口令…"}</text>
    <text fg={props.context.theme.text.muted}>Enter 确定 · Esc 取消 · Ctrl+U 清空 · 支持粘贴</text>
  </box>;
}
