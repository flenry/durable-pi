import { createHash } from "node:crypto";
import {
  ROOT_CONVERSATION_ID,
  defineExtension,
  hook,
  ToolTask,
  type ConversationId,
  type Extension,
} from "@earendil-works/pi-durable";
import { ExpertIdentity } from "./experts.js";
import { findDestructiveCommand, isAmbiguousTestScript, rewriteCommand } from "./guard-rules.js";

const APPROVAL_TTL_MS = 10 * 60_000;
const MAX_APPROVALS = 64;
export const GUARD_BLOCKED_MARKER = "DPI_GUARD_BLOCKED:";

function commandHash(command: string): string {
  return createHash("sha256").update(command, "utf8").digest("hex");
}

/** Stable SHA-256 of the exact bash string, including whitespace and quoting. */
export const commandApprovalHash = commandHash;

export interface GuardApprovalHost {
  /** Register an exact command that a human can approve from the root conversation. */
  request(command: string): string;
  /** Host-only write called by Store.send for a user message; non-root conversations cannot grant. */
  approve(hash: string, conversationId: ConversationId): boolean;
  /** Atomically consume a previously host-approved exact command, at most once. */
  consume(command: string): boolean;
}

/**
 * Process-local, host-owned approvals. Restart drops pending/approved records, which is fail-closed; the model has no
 * tool for writing this map. A human must reply with the hash shown by the blocked tool result.
 */
export function createGuardApprovalHost(options: { now?: () => number; ttlMs?: number } = {}): GuardApprovalHost {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? APPROVAL_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("guard approval ttlMs must be a positive safe integer");
  const records = new Map<string, { expiresAt: number; approved: boolean }>();
  const prune = () => {
    const at = now();
    for (const [hash, record] of records) if (record.expiresAt <= at) records.delete(hash);
    while (records.size > MAX_APPROVALS) records.delete(records.keys().next().value!);
  };
  return {
    request(command) {
      prune();
      const hash = commandHash(command);
      if (!records.has(hash)) records.set(hash, { expiresAt: now() + ttlMs, approved: false });
      return hash;
    },
    approve(hash, conversationId) {
      prune();
      if (conversationId !== ROOT_CONVERSATION_ID || !/^[a-f0-9]{64}$/i.test(hash)) return false;
      const record = records.get(hash.toLowerCase());
      if (!record || record.expiresAt <= now()) return false;
      record.approved = true;
      return true;
    },
    consume(command) {
      prune();
      const hash = commandHash(command);
      const record = records.get(hash);
      if (!record?.approved) return false;
      records.delete(hash);
      return true;
    },
  };
}

/** Only an exact root-chat reply can grant an approval. */
export function commandApprovalFromUserMessage(content: string): string | undefined {
  const match = /^\s*approve\s+([a-f0-9]{64})\s*$/i.exec(content);
  return match?.[1].toLowerCase();
}

function blocked(label: string, reason: string, hash: string): string {
  return `${GUARD_BLOCKED_MARKER} Blocked destructive command (${label}): ${reason} ` +
    `The user must reply exactly: approve ${hash}. Do not self-approve or change the command; then re-run it once. ` +
    `Unattended ticket workers must stop and report TICKET_STATUS: BLOCKED: command needs approval (${label}).`;
}

/** Installable default-on extension for test-runner safety and one-shot destructive-command approvals. */
export function createGuardsExtension(approvals: GuardApprovalHost): Extension {
  return defineExtension({
    name: "durable-guards",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          if (call.name !== "bash") return;
          const raw = (call.arguments as { command?: unknown }).command;
          if (typeof raw !== "string") return { block: `${GUARD_BLOCKED_MARKER} Bash command could not be inspected; refusing to run it.` };
          const command = raw;
          const destructive = findDestructiveCommand(command);
          if (destructive) {
            let ticketWorker = false;
            try {
              const identity = await api.snapshot(ExpertIdentity, api.conversationId, context);
              ticketWorker = typeof identity?.ticketSliceId === "string";
            } catch {
              // The generic block still fails closed, and the ticket runner independently detects this marker.
            }
            if (ticketWorker) {
              return {
                block: `${GUARD_BLOCKED_MARKER} TICKET_STATUS: BLOCKED: command needs approval (${destructive.label}). ` +
                  "No user is available during an unattended ticket run; stop without retrying the destructive command.",
              };
            }
            try {
              if (!approvals.consume(command)) {
                const hash = approvals.request(command);
                return { block: blocked(destructive.label, destructive.reason, hash) };
              }
            } catch {
              return { block: `${GUARD_BLOCKED_MARKER} Approval state is unavailable; refusing destructive command (${destructive.label}).` };
            }
          }

          if (isAmbiguousTestScript(command)) {
            return {
              block:
                "Blocked by durable-guards: bare `npm test`/`npm t`/`yarn test` can spawn watch mode or unlimited workers. " +
                "Use `pnpm vitest run --pool=forks --maxWorkers=2`, `npx jest --runInBand --forceExit`, or `npx playwright test --workers=1`.",
            };
          }

          const rewritten = rewriteCommand(command);
          if (!rewritten) return;
          return { arguments: { ...call.arguments, command: rewritten.command } };
        },
      }),
    ],
  });
}
