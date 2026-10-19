import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SkillCatalogEntry } from "../../dpi-sdk/src/api.js";
import {
  filterSlashMenu,
  mergeSlashMenu,
} from "../apps/dpi-playground-fe/src/client/slash-menu.js";
import { getSkillCatalogForDevice } from "../apps/dpi-playground-fe/src/client/skill-catalog.js";

const realCatalog = JSON.parse(
  readFileSync(new URL("./fixtures/real-skill-catalog.json", import.meta.url), "utf8"),
) as SkillCatalogEntry[];
const builtIns = [
  { name: "compact", args: "[instructions]", description: "Summarize older context" },
  { name: "help", description: "How this works" },
];

test("slash menu merges real skill and prompt catalog entries with built-ins", () => {
  const items = mergeSlashMenu(builtIns, realCatalog);

  assert.deepEqual(items.slice(0, 2), [
    {
      name: "compact",
      args: "[instructions]",
      description: "Summarize older context",
      kind: "command",
    },
    { name: "help", description: "How this works", kind: "command" },
  ]);
  assert.deepEqual(items.slice(2), [
    { name: "brainstorm", description: realCatalog[0].description, kind: "prompt" },
    { name: "code-review", description: realCatalog[1].description, kind: "skill" },
    { name: "frontend-design", description: realCatalog[2].description, kind: "skill" },
    { name: "grill", description: realCatalog[3].description, kind: "skill" },
  ]);
});

test("an empty device catalog leaves built-in commands available", () => {
  assert.deepEqual(mergeSlashMenu(builtIns, []), [
    { ...builtIns[0], kind: "command" },
    { ...builtIns[1], kind: "command" },
  ]);
});

test("built-ins win name clashes with a device skill", () => {
  const items = mergeSlashMenu(builtIns, [
    { name: "help", description: "Device help skill", kind: "skill" },
  ]);

  assert.equal(items.filter((item) => item.name === "help").length, 1);
  assert.deepEqual(
    items.find((item) => item.name === "help"),
    {
      name: "help",
      description: "How this works",
      kind: "command",
    },
  );
});

test("slash menu filters names case-insensitively by prefix", () => {
  const items = mergeSlashMenu(builtIns, realCatalog);

  assert.deepEqual(filterSlashMenu(items, "FRONT"), [items[4]]);
  assert.deepEqual(filterSlashMenu(items, "bRai"), [items[2]]);
  assert.deepEqual(filterSlashMenu(items, "missing"), []);
});

test("device skill catalogs are cached per device and concurrent callers share a fetch", async () => {
  let calls = 0;
  const load = async () => {
    calls++;
    return realCatalog.map((entry) => ({ ...entry }));
  };

  const [first, concurrent] = await Promise.all([
    getSkillCatalogForDevice("local-test-device", load),
    getSkillCatalogForDevice("local-test-device", load),
  ]);
  const cached = await getSkillCatalogForDevice("local-test-device", load);
  const otherDevice = await getSkillCatalogForDevice("remote-test-device", load);

  assert.equal(calls, 2);
  assert.strictEqual(first, concurrent);
  assert.strictEqual(first, cached);
  assert.notStrictEqual(cached, otherDevice);
  assert.deepEqual(cached, realCatalog);
});

test("failed skill catalog requests are not cached, so a later selection can retry", async () => {
  await assert.rejects(
    getSkillCatalogForDevice("retry-test-device", async () => {
      throw new Error("offline");
    }),
    /offline/,
  );

  assert.deepEqual(
    await getSkillCatalogForDevice("retry-test-device", async () => realCatalog),
    realCatalog,
  );
});
