import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { TranscriptItem } from "../../dpi-sdk/src/transcript.js";
import {
  guardApprovalStates,
  parseGuardBlockedResult,
} from "../apps/dpi-playground-fe/src/client/guard-approval.js";

const hash = "a".repeat(64);
const realTranscript = JSON.parse(
  readFileSync(
    new URL("../../../docs/workers/polish/real-blocked-transcript.json", import.meta.url),
    "utf8",
  ),
) as { items: TranscriptItem[] };
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
const assistantTool = (id: number, callId: string, text: string): TranscriptItem => ({
  kind: "assistant",
  id,
  streaming: false,
  blocks: [
    {
      type: "tool",
      call: {
        callId,
        name: "bash",
        args: { command: "rm -rf scratch" },
        status: "error",
        result: text,
      },
    },
  ],
});

test("real blocked transcript fixture exposes its assistant tool-block approval", () => {
  const states = guardApprovalStates(realTranscript.items);
  assert.equal(states.size, 1);
  assert.equal(
    states.get(
      "call_2904f8b2ca4f43ada923f995a44c22a8|fc_0af2e1b1a029211f016ad5c59f941881918ab57d454510d21a",
    )?.status,
    "pending",
  );
  assert.deepEqual(
    [...states.values()],
    [
      {
        request: {
          hash: "527e6747ce5a7156cea93abc30891efc199ee75b99fc2540bd86c7f341f3cb3c",
          label: "rm -rf",
          reason: "Recursive force-delete — can wipe directories irrecoverably.",
        },
        status: "pending",
      },
    ],
  );
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

test("assistant tool blocks are resolved by an exact approval message", () => {
  const items: TranscriptItem[] = [
    assistantTool(1, "tool-call", block()),
    { kind: "user", id: 2, text: `approve ${hash}` },
  ];
  assert.equal(guardApprovalStates(items).get("tool-call")?.status, "sent");
});

test("a newer assistant tool block supersedes an earlier request for the same hash", () => {
  const items: TranscriptItem[] = [
    assistantTool(1, "old-call", block()),
    { kind: "user", id: 2, text: `approve ${hash}` },
    assistantTool(3, "new-call", block()),
  ];
  const states = guardApprovalStates(items);
  assert.equal(states.get("old-call")?.status, "superseded");
  assert.equal(states.get("new-call")?.status, "pending");
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
