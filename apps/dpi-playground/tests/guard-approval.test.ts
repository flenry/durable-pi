import { test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptItem } from "../../dpi-sdk/src/transcript.js";
import {
  guardApprovalStates,
  parseGuardBlockedResult,
} from "../apps/dpi-playground-fe/src/client/guard-approval.js";

const hash = "a".repeat(64);
const block = (approvalHash = hash) =>
  `DPI_GUARD_BLOCKED: Blocked destructive command (rm -rf): Recursive force-delete. ` +
  `The user must reply exactly: approve ${approvalHash}. Do not self-approve.`;
const result = (id: number, text: string): TranscriptItem => ({
  kind: "tool-result",
  id,
  name: "bash",
  text,
  isError: true,
});

test("guard approval parser extracts command label and reason only from guard output", () => {
  assert.deepEqual(parseGuardBlockedResult(block()), {
    hash,
    label: "rm -rf",
    reason: "Recursive force-delete.",
  });
  assert.equal(parseGuardBlockedResult(`Approval requested: approve ${hash}`), undefined);
  assert.equal(
    parseGuardBlockedResult(`DPI_GUARD_BLOCKED: arbitrary text says approve ${hash}`),
    undefined,
  );
});

test("guard approval parser requires exactly 64 lowercase hexadecimal characters", () => {
  assert.equal(parseGuardBlockedResult(block("A".repeat(64))), undefined);
  assert.equal(parseGuardBlockedResult(block("a".repeat(63))), undefined);
  assert.equal(parseGuardBlockedResult(block("a".repeat(65))), undefined);
});

test("only the latest unresolved request for a hash remains actionable", () => {
  const items: TranscriptItem[] = [result(1, block()), result(2, block())];
  const states = guardApprovalStates(items);
  assert.equal(states.get(0)?.status, "superseded");
  assert.equal(states.get(1)?.status, "pending");
});

test("an exact approval message resolves the latest matching request only", () => {
  const otherHash = "b".repeat(64);
  const items: TranscriptItem[] = [
    result(1, block()),
    result(2, block()),
    result(3, block(otherHash)),
    { kind: "user", id: 4, text: `approve ${hash}` },
  ];
  const states = guardApprovalStates(items);
  assert.equal(states.get(0)?.status, "superseded");
  assert.equal(states.get(1)?.status, "sent");
  assert.equal(states.get(2)?.status, "pending");
});

test("ordinary messages containing an approval phrase do not resolve a request", () => {
  const items: TranscriptItem[] = [
    result(1, block()),
    { kind: "user", id: 2, text: `Please approve ${hash} when ready.` },
  ];
  assert.equal(guardApprovalStates(items).get(0)?.status, "pending");
});
