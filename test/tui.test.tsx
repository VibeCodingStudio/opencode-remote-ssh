import { test, expect } from "bun:test";
import { createSignal, type JSX } from "solid-js";
import { testRender } from "@opentui/solid";
import type { Plugin } from "@opencode/plugin/tui";
import { passwordDialog } from "../src/tui/password.tsx";
import plugin from "../src/tui/index.tsx";

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

test("sidebar displays the current host/directory and mouse opens exactly the agreed actions", async () => {
  let renderSlot: ((props: { sessionID: string }) => JSX.Element) | undefined;
  const menus: string[][] = [];
  let configured = false;
  const state = { hosts: [{ host: { id: "host", name: "开发服务器" }, status: "connected", directory: "/home/dev/project", home: "/home/dev", current: true, changed: false }], requests: [] };
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
    expect(frame).toContain("当前");
    const rows = frame.split("\n");
    const y = rows.findIndex(row => row.includes("开发服务器"));
    await ui.mockMouse.click(3, y);
    await ui.waitFor(() => menus.length > 0);
    expect(menus[0]).toEqual(["设为当前目标", "测试连接", "断开连接"]);
  } finally { await cleanup?.(); ui.renderer.destroy(); }
});
