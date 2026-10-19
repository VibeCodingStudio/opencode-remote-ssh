import { test, expect } from "bun:test";
import { createSignal, type JSX } from "solid-js";
import { testRender } from "@opentui/solid";
import type { Plugin } from "@opencode/plugin/tui";
import { passwordDialog } from "../src/tui/password.tsx";
import plugin from "../src/tui/index.tsx";

async function navigateConfiguration(choices: (string | undefined)[], prompts: (string | undefined)[] = []) {
  const menus: { title: string; current?: string; options: { value: string }[] }[] = [];
  const errors: string[] = [];
  let open: (() => void) | undefined;
  const finished = Promise.withResolvers<void>();
  const host = { id: "host", name: "fixture", hostname: "example.test", port: 22, username: "dev", auth: "password", remembered: false };
  const context = {
    location: { directory: "/fixture" },
    client: { rpc: () => ({ state: async () => ({ hosts: [{ host }], requests: [] }), events: { on: () => () => {} } }) },
    keymap: { layer: (factory: () => { commands: { run: () => void }[] }) => { open = factory().commands[0].run; } },
    ui: {
      router: { current: () => ({ type: "home" }) }, slot: () => () => {},
      dialog: {
        select: async (input: typeof menus[number]) => {
          menus.push(input);
          if (!choices.length) { finished.resolve(); return undefined; }
          return choices.shift();
        },
        prompt: async () => prompts.shift(),
      },
      toast: { show: (input: { message: string; variant: string }) => { if (input.variant === "error") { errors.push(input.message); finished.resolve(); } } },
    },
  } as unknown as Plugin.Context;
  const cleanup = await plugin.setup(context);
  try {
    open!();
    await finished.promise;
    expect(errors).toEqual([]);
    return menus;
  } finally { await cleanup?.(); }
}

test("SSH editor restores the selected field after submit, cancel, toggle, and changing authentication", async () => {
  const menus = await navigateConfiguration(["new", "port", "username", "remember", "auth", "key", "jump", undefined], ["2222", undefined]);
  const editor = menus.filter(menu => menu.title === "添加 SSH 主机");
  expect(editor.slice(1).map(menu => menu.current)).toEqual(["port", "username", "remember", "auth", "jump"]);
  expect(editor.at(-1)?.options.map(option => option.value)).toContain("privateKeyPath");
});

test("SSH configuration restores the host and its last action when returning from a submenu", async () => {
  const menus = await navigateConfiguration(["host", undefined, "host", "edit", undefined, "host", undefined]);
  expect(menus.filter(menu => menu.title === "SSH 主机配置").slice(1).map(menu => menu.current)).toEqual(["host", "host", "host"]);
  expect(menus.filter(menu => menu.title === "fixture").at(-1)?.current).toBe("edit");
});

test("sudo credential dialog reuses SSH only after selection and sends no password back to the model", async () => {
  const replied = Promise.withResolvers<Record<string, unknown>>();
  let pending = true;
  const choices: string[] = [];
  const context = {
    location: { directory: "/fixture" },
    client: { rpc: () => ({
      state: async () => ({ hosts: [], requests: pending ? [{ id: "request", hostId: "host", hostName: "fixture", kind: "sudo", sessionId: "s", canReuseSSH: true }] : [] }),
      events: { on: () => () => {} },
      credential: async (input: Record<string, unknown>) => { pending = false; replied.resolve(input); },
    }) },
    keymap: { layer: () => {} },
    data: { session: { permission: { list: () => [] } } },
    ui: {
      router: { current: () => ({ type: "home" }) }, slot: () => () => {},
      dialog: {
        select: async (input: { options: { value: string }[] }) => { choices.push(...input.options.map(option => option.value)); return "ssh"; },
        confirm: async () => false, clear: () => {},
      },
      toast: { show: () => {} },
    },
  } as unknown as Plugin.Context;
  const cleanup = await plugin.setup(context);
  try {
    const reply = await replied.promise;
    expect(choices).toEqual(["ssh", "manual"]);
    expect(reply).toEqual({ requestId: "request", value: undefined, reuseSSH: true, remember: false });
  } finally { await cleanup?.(); }
});

test("password entry masks typing/paste, handles grapheme backspace, and returns only through submit", async () => {
  const [dialog, setDialog] = createSignal<(() => JSX.Element) | undefined>();
  const context = {
    theme: { text: { base: "#ffffff", muted: "#aaaaaa" } },
    keymap: { mode: { push: () => () => {} } },
    ui: { dialog: { show: (render: () => JSX.Element) => setDialog(() => render), clear: () => setDialog(undefined) }, toast: { show: () => {} } },
  } as unknown as Plugin.Context;
  const ui = await testRender(() => <box>{dialog()?.()}</box>, { width: 80, height: 12 });
  try {
    const result = passwordDialog(context, "测试密码");
    await ui.renderOnce();
    await ui.mockInput.typeText("secret");
    await ui.mockInput.pasteBracketedText("口令🗝");
    ui.mockInput.pressBackspace();
    await ui.renderOnce();
    const frame = ui.captureCharFrame();
    expect(frame).toContain("●");
    expect(frame).not.toContain("secret");
    expect(frame).not.toContain("口令");
    ui.mockInput.pressEnter();
    expect(await result).toBe("secret口令");
    const cancelled = passwordDialog(context, "取消测试");
    await ui.renderOnce();
    await ui.mockInput.typeText("discard-me");
    ui.mockInput.pressEscape();
    expect(await cancelled).toBeUndefined();
  } finally { ui.renderer.destroy(); }
});

test("sidebar displays host directories without a current target and opens connection actions", async () => {
  let renderSlot: ((props: { sessionID: string }) => JSX.Element) | undefined;
  const menus: string[][] = [];
  let configured = false;
  const state = { hosts: [{ host: { id: "host", name: "开发服务器" }, status: "connected", directory: "/home/dev/project", home: "/home/dev", changed: false }], requests: [] };
  const context = {
    location: { directory: "/fixture" },
    theme: { text: { base: "#ffffff", muted: "#aaaaaa", feedback: { error: { base: "#ff0000" } } } },
    client: { rpc: () => ({ state: async () => state, events: { on: () => () => {} } }) },
    keymap: { layer: (factory: () => { commands: { slash?: { name: string } }[] }) => { configured = factory().commands[0].slash?.name === "ssh"; } },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "s" }) },
      slot: (claim: { render: typeof renderSlot }) => { renderSlot = claim.render; return () => {}; },
      dialog: { select: async (input: { options: { title: string }[] }) => { menus.push(input.options.map(v => v.title)); return undefined; } },
      toast: { show: () => {} },
    },
    data: { session: { permission: { list: () => [] } } },
  } as unknown as Plugin.Context;
  const cleanup = await plugin.setup(context);
  const ui = await testRender(() => <box>{renderSlot?.({ sessionID: "s" })}</box>, { width: 60, height: 20 });
  try {
    await ui.waitForFrame(frame => frame.includes("开发服务器"));
    const frame = ui.captureCharFrame();
    expect(configured).toBe(true);
    expect(frame).toContain("/home/dev/project");
    expect(frame).not.toContain("当前");
    const rows = frame.split("\n");
    const y = rows.findIndex(row => row.includes("开发服务器"));
    await ui.mockMouse.click(3, y);
    await ui.waitFor(() => menus.length > 0);
    expect(menus[0]).toEqual(["连接", "测试连接", "断开连接"]);
  } finally { await cleanup?.(); ui.renderer.destroy(); }
});
