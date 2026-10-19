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
 * Classify guard blocks in transcript order. A later block supersedes an older request for the same hash;
 * an exact approval message marks the latest matching request as sent and removes its button.
 */
export function guardApprovalStates(
  items: readonly TranscriptItem[],
): Map<number, GuardApprovalState> {
  const states = new Map<number, GuardApprovalState>();
  const latestByHash = new Map<string, number>();

  items.forEach((item, index) => {
    if (item.kind === "tool-result") {
      const request = parseGuardBlockedResult(item.text);
      if (!request) return;

      const previousIndex = latestByHash.get(request.hash);
      if (previousIndex !== undefined) {
        const previous = states.get(previousIndex);
        if (previous) states.set(previousIndex, { ...previous, status: "superseded" });
      }
      states.set(index, { request, status: "pending" });
      latestByHash.set(request.hash, index);
      return;
    }

    if (item.kind !== "user") return;
    const hash = parseApprovalMessage(item.text);
    if (!hash) return;
    const indexToResolve = latestByHash.get(hash);
    if (indexToResolve === undefined) return;
    const state = states.get(indexToResolve);
    if (state) states.set(indexToResolve, { ...state, status: "sent" });
    latestByHash.delete(hash);
  });

  return states;
}
