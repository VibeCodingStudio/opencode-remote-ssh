import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const modules = process.env.REMOTE_SSH_HOST_MODULES;
const entrypoint = process.env.REMOTE_SSH_PACKAGE_TUI;
if (!modules || !entrypoint) throw new Error("Run through npm run test:tui-package");
const hostModule = relative => pathToFileURL(path.join(modules, relative)).href;

// Match the host's client-side Solid bindings before registering its loader.
// The transform still deliberately excludes the installed node_modules entrypoint.
await import(hostModule("@opentui/solid/scripts/preload.js"));
const { ensurePluginRuntime, provides } = await import(hostModule("@opencode/plugin/dist/runtime.js"));
const { Plugin, PluginContextProvider, usePlugin } = await import(hostModule("@opencode/plugin/dist/tui/index.js"));
const { ensureRuntimePluginSupport } = await import(hostModule("@opentui/solid/scripts/runtime-plugin-support-configure.js"));
ensurePluginRuntime();
ensureRuntimePluginSupport({ additional: { "@opencode/plugin/tui": { Plugin, PluginContextProvider, usePlugin } }, preserve: provides });
const { testRender } = await import(hostModule("@opentui/solid/index.bun.js"));
const { default: plugin } = await import(pathToFileURL(entrypoint).href);
assert.equal(plugin.id, "studio.remote-ssh.tui");

let renderSlot;
let hasCommand = false;
const menus = [];
const context = {
  location: { directory: process.cwd() },
  theme: { text: { base: "#ffffff", muted: "#aaaaaa", feedback: { error: { base: "#ff0000" } } } },
  client: { rpc: () => ({
    state: async () => ({ hosts: [{ host: { id: "host", name: "开发服务器" }, status: "connected", directory: "/home/dev/project", home: "/home/dev", current: true, changed: false }], requests: [] }),
    events: { on: () => () => {} },
  }) },
  keymap: { layer: factory => { hasCommand = factory().commands[0].slash?.name === "ssh"; } },
  ui: {
    router: { current: () => ({ type: "session", sessionID: "fixture" }) },
    slot: claim => { renderSlot = claim.render; return () => {}; },
    dialog: { select: async input => { menus.push(input.options.map(option => option.title)); } },
    toast: { show: () => {} },
  },
  data: { session: { permission: { list: () => [] } } },
};
const cleanup = await plugin.setup(context);
const ui = await testRender(() => renderSlot({ sessionID: "fixture" }), { width: 60, height: 20 });
try {
  const frame = await ui.waitForFrame(value => value.includes("开发服务器"));
  assert.equal(hasCommand, true);
  assert.ok(frame.includes("/home/dev/project"));
  assert.ok(frame.includes("当前"));
  const row = frame.split("\n").findIndex(value => value.includes("开发服务器"));
  await ui.mockMouse.click(3, row);
  await ui.waitFor(() => menus.length > 0);
  assert.deepEqual(menus[0], ["设为当前目标", "测试连接", "断开连接"]);
  console.log("Installed TUI entrypoint loaded, rendered, and handled a host click without React.");
} finally { await cleanup?.(); ui.renderer.destroy(); }
