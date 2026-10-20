import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentSummary } from "../../dpi-sdk/src/api.js";
import { DpiError } from "../../dpi-sdk/src/errors.js";
import {
  isBusyCloseError,
  mergeClosedAgents,
  parentAfterClosing,
  parentAfterDisappearance,
} from "../apps/dpi-playground-fe/src/client/agent-close.js";

const agent = (patch: Partial<AgentSummary> & Pick<AgentSummary, "id" | "kind">): AgentSummary => ({
  name: `Agent ${patch.id}`,
  named: false,
  busy: false,
  background: 0,
  closed: false,
  ...patch,
});

const tree = [
  agent({ id: 1, kind: "root", name: "Main" }),
  agent({ id: 2, kind: "subagent", ownerAgentId: 1, name: "Worker" }),
  agent({ id: 3, kind: "fork", parentId: 2, forkedAt: 4, name: "Nested fork" }),
];

test("closing the selected agent or an ancestor falls back outside the closed branch", () => {
  assert.equal(parentAfterClosing(tree, 2, 2), 1);
  assert.equal(parentAfterClosing(tree, 3, 2), 1);
  assert.equal(parentAfterClosing(tree, 1, 2), undefined);
});

test("a disappearing selected descendant falls back to its nearest surviving parent", () => {
  assert.equal(parentAfterDisappearance(tree, 3, new Set([1])), 1);
  assert.equal(parentAfterDisappearance(tree, 2, new Set([1])), 1);
  assert.equal(parentAfterDisappearance(tree, 2, new Set()), undefined);
});

test("a default live snapshot updates visible records and marks only a newly hidden branch closed", () => {
  const all = [
    agent({ id: 1, kind: "root", name: "Main" }),
    agent({ id: 2, kind: "subagent", ownerAgentId: 1, name: "Worker" }),
    agent({ id: 3, kind: "fork", parentId: 2, forkedAt: 4, name: "Nested fork" }),
  ];
  const visible = [agent({ id: 1, kind: "root", name: "Main (updated)" })];
  const merged = mergeClosedAgents(all, visible);

  assert.equal(merged[0].name, "Main (updated)");
  assert.equal(merged[1].closed, true);
  assert.equal(merged[2].closed, false, "descendants retain their own persisted closed state");
});

test("the busy API conflict is the only error eligible for stop-and-close confirmation", () => {
  assert.equal(isBusyCloseError(new DpiError("busy", "Agent busy", 409)), true);
  assert.equal(isBusyCloseError(new DpiError("offline", "Device offline", 0)), false);
  assert.equal(isBusyCloseError(new Error("busy")), false);
});
