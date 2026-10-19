import type { TranscriptItem } from "@sdk/transcript";

const GUARD_BLOCKED_MARKER = "DPI_GUARD_BLOCKED:";

export interface GuardApprovalRequest {
  hash: string;
  label: string;
  reason: string;
}

export type GuardApprovalStatus = "pending" | "sent" | "superseded";

export interface GuardApprovalState {
  request: GuardApprovalRequest;
  status: GuardApprovalStatus;
}

/** Assistant tool calls use their callId; standalone tool-result items use their item index. */
export type GuardApprovalKey = string | number;

/** Read an actionable approval request only from a durable-guards block. */
export function parseGuardBlockedResult(text: string): GuardApprovalRequest | undefined {
  const marker = text.indexOf(GUARD_BLOCKED_MARKER);
  if (marker < 0) return undefined;

  const guardedText = text.slice(marker + GUARD_BLOCKED_MARKER.length);
  const match =
    /^\s*Blocked destructive command \(([^)\r\n]+)\): ([\s\S]*?)\s+The user must reply exactly:\s+approve\s+([a-f0-9]{64})(?=$|[\s.,;])/u.exec(
      guardedText,
    );
  if (!match) return undefined;

  return { label: match[1], reason: match[2].trim(), hash: match[3] };
}

/** Exact approval messages accepted by the backend's root-chat parser. */
function parseApprovalMessage(text: string): string | undefined {
  const match = /^\s*approve\s+([a-f0-9]{64})\s*$/iu.exec(text);
  return match?.[1].toLowerCase();
}

/**
 * Classify guard blocks in transcript order. Assistant tool blocks are keyed by callId, while
 * standalone tool-result items use their transcript index. A newer block supersedes the older
 * request for the same hash; an exact approval message marks the latest request as sent.
 */
export function guardApprovalStates(
  items: readonly TranscriptItem[],
): Map<GuardApprovalKey, GuardApprovalState> {
  const states = new Map<GuardApprovalKey, GuardApprovalState>();
  const latestByHash = new Map<string, GuardApprovalKey>();

  const addRequest = (key: GuardApprovalKey, text: string) => {
    const request = parseGuardBlockedResult(text);
    if (!request) return;

    const previousKey = latestByHash.get(request.hash);
    if (previousKey !== undefined) {
      const previous = states.get(previousKey);
      if (previous) states.set(previousKey, { ...previous, status: "superseded" });
    }
    states.set(key, { request, status: "pending" });
    latestByHash.set(request.hash, key);
  };

  items.forEach((item, index) => {
    if (item.kind === "user") {
      const hash = parseApprovalMessage(item.text);
      if (!hash) return;
      const keyToResolve = latestByHash.get(hash);
      if (keyToResolve === undefined) return;
      const state = states.get(keyToResolve);
      if (state?.status === "pending") states.set(keyToResolve, { ...state, status: "sent" });
      return;
    }

    if (item.kind === "assistant") {
      for (const block of item.blocks)
        if (block.type === "tool" && typeof block.call.result === "string")
          addRequest(block.call.callId, block.call.result);
      return;
    }

    if (item.kind === "tool-result") addRequest(index, item.text);
  });

  return states;
}
