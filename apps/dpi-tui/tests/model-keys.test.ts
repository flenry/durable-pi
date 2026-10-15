import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../src/app.ts";
import { cycleModel } from "../src/pickers.ts";
import type { TuiInputListenerResult } from "@earendil-works/pi-tui";

function fakeApp(current = { provider: "one", modelId: "shared" }) {
  const configured: unknown[] = [];
  const notices: string[] = [];
  const app = {
    overlays: [],
    editor: { getText: () => "draft stays unchanged" },
    info: { models: [
      { provider: "one", id: "shared", name: "First" },
      { provider: "two", id: "shared", name: "Second" },
      { provider: "two", id: "last", name: "Last" },
    ] },
    model: { state: { agent: { model: current } } },
    handle: { configure: async (value: unknown) => { configured.push(value); } },
    run: async (fn: () => Promise<void>) => { await fn(); },
    flash: (text: string) => { notices.push(text); },
  };
  return { app: app as unknown as App, configured, notices };
}

for (const [key, direction] of [["\x10", 1], ["\x1b[112;6u", -1]] as const) {
  test(`model cycling shortcut routes direction ${direction} and consumes input`, async () => {
    const { app, configured } = fakeApp();
    const keyHandler = (App.prototype as unknown as { key(data: string): TuiInputListenerResult }).key;
    assert.deepEqual(keyHandler.call(app, key), { consume: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(configured, [{ model: direction === 1
      ? { provider: "two", modelId: "shared" }
      : { provider: "two", modelId: "last" } }]);
    assert.equal((app as unknown as { editor: { getText(): string } }).editor.getText(), "draft stays unchanged");
  });
}

test("cycling matches provider plus id and wraps in both directions", async () => {
  const second = fakeApp({ provider: "two", modelId: "shared" });
  await cycleModel(second.app, 1);
  assert.deepEqual(second.configured, [{ model: { provider: "two", modelId: "last" } }]);
  const last = fakeApp({ provider: "two", modelId: "last" });
  await cycleModel(last.app, 1);
  assert.deepEqual(last.configured, [{ model: { provider: "one", modelId: "shared" } }]);
  assert.match(last.notices[0], /First.*next turn/);
});

test("unknown current model selects first forward and last backward", async () => {
  for (const direction of [1, -1] as const) {
    const f = fakeApp({ provider: "missing", modelId: "missing" });
    await cycleModel(f.app, direction);
    assert.deepEqual(f.configured, [{ model: direction === 1
      ? { provider: "one", modelId: "shared" }
      : { provider: "two", modelId: "last" } }]);
  }
});

test("no agent, no models, and open overlays do not configure a model", async () => {
  const keyHandler = (App.prototype as unknown as { key(data: string): TuiInputListenerResult }).key;
  const noAgent = fakeApp();
  noAgent.app.handle = undefined;
  await cycleModel(noAgent.app, 1);
  assert.deepEqual(noAgent.configured, []);
  const empty = fakeApp();
  empty.app.info.models = [];
  await cycleModel(empty.app, 1);
  assert.deepEqual(empty.configured, []);
  const overlay = fakeApp();
  (overlay.app as unknown as { overlays: unknown[] }).overlays = [{}];
  assert.equal(keyHandler.call(overlay.app, "\x10"), undefined);
  assert.deepEqual(overlay.configured, []);
});
