import { Type } from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID, defineDoc, defineExtension, defineTask, defineTool, type TaskRuntime, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context, JsonValue } from "@earendil-works/chord";

const ReminderState = defineDoc<{ [key: string]: JsonValue; items: Record<string, ReminderRecord> }>({
  kind: "dpi.onboard-reminders",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ items: {} }),
});

export interface ReminderRecord extends Record<string, JsonValue> {
  id: string;
  message: string;
  when: number;
  status: "pending" | "fired" | "cancelled";
  createdAt: number;
  firedAt: number | null;
  taskId: number;
}
interface ReminderInput { id: string; message: string; when: number }
interface ReminderCheckpoint { phase: "wait" }
interface ReminderResult { id: string; fired: boolean }
type ReminderRuntime = TaskRuntime<ReminderInput, ReminderCheckpoint, ReminderResult, object>;

const MAX_REMINDER_MS = 365 * 24 * 60 * 60_000;

export function parseReminderWhen(value: string, now = Date.now()): number {
  const text = value.trim();
  const relative = /^(?:in\s+)?(\d+)(m|min|minutes?|h|hours?|d|days?)$/i.exec(text);
  let timestamp: number;
  if (relative) {
    const amount = Number(relative[1]);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Reminder duration must be a positive duration");
    const unit = relative[2].toLowerCase();
    const multiplier = unit.startsWith("m") ? 60_000 : unit.startsWith("h") ? 60 * 60_000 : 24 * 60 * 60_000;
    timestamp = now + amount * multiplier;
  } else {
    timestamp = Date.parse(text);
    if (!Number.isFinite(timestamp)) throw new Error("when must be an ISO timestamp or duration such as 10m, 2h, or 1d");
  }
  if (timestamp <= now) throw new Error("Reminder time must be in the future");
  if (timestamp - now > MAX_REMINDER_MS) throw new Error("Reminder time must be within one year");
  return timestamp;
}

function createReminderTask(now: () => number, timer?: (deadline: number, signal?: AbortSignal) => Promise<void>) {
  return defineTask<ReminderInput, ReminderCheckpoint, ReminderResult>({
    name: "dpi.reminder",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (task, runtime, ctx) => {
        if (timer) await timer(task.input.when, runtime.signal);
        else await runtime.sleep(task.input.when, ctx);
        await runtime.commit(async (tx) => {
          const reminders = await tx.doc(ReminderState, task.conversationId);
          const item = reminders.items[task.input.id];
          if (!item || item.status !== "pending")
            return { status: "terminal", outcome: { status: "completed", result: { id: task.input.id, fired: false } } };
          item.status = "fired";
          item.firedAt = now();
          await tx.appendEntry(task.conversationId, {
            kind: "dpi.reminder",
            data: { id: item.id, message: item.message, text: item.message, scheduledAt: item.when, firedAt: item.firedAt },
          });
          return { status: "terminal", outcome: { status: "completed", result: { id: item.id, fired: true } } };
        }, ctx);
      },
    },
    abort: async (task, runtime, ctx) => {
      await runtime.commit(async (tx) => {
        const reminders = await tx.doc(ReminderState, task.conversationId);
        const item = reminders.items[task.input.id];
        if (item?.status === "pending") item.status = "cancelled";
        return { status: "terminal", outcome: { status: "aborted", reason: "Reminder cancelled" } };
      }, ctx);
    },
  });
}

function rootOnly(api: ToolExecutionApi) {
  if (api.conversationId !== ROOT_CONVERSATION_ID) throw new Error("Reminder tools are available only to root conversations");
}

export function createRemindExtension(options: {
  now?: () => number;
  timer?: (deadline: number, signal?: AbortSignal) => Promise<void>;
  abortTask?: (taskId: number) => Promise<unknown>;
} = {}) {
  const now = options.now ?? Date.now;
  const reminderTask = createReminderTask(now, options.timer);

  const remind = defineTool({
    name: "remind",
    description: "Set a durable reminder for an ISO timestamp or a relative duration (for example 10m, 2h, 1d). It fires once and survives backend restart.",
    parameters: Type.Object({ when: Type.String({ minLength: 1 }), message: Type.String({ minLength: 1, maxLength: 1000 }) }),
    replay: "safe",
    execute: async (args: { when: string; message: string }, api: ToolExecutionApi, ctx: Context) => {
      rootOnly(api);
      const when = parseReminderWhen(args.when, now());
      const message = args.message.trim();
      if (!message) throw new Error("message must not be empty");
      let id = String(api.taskId);
      await api.commit(async (tx) => {
        const reminders = await tx.doc(ReminderState, api.conversationId);
        const existing = reminders.items[id];
        if (existing) return;
        const taskId = await tx.createTask(reminderTask, { id, message, when }, { ownership: { kind: "conversation" }, background: true });
        reminders.items[id] = { id, message, when, status: "pending", createdAt: now(), firedAt: null, taskId: taskId as number };
      }, ctx);
      const label = new Date(when).toISOString();
      return { content: [{ type: "text" as const, text: `Reminder ${id} set for ${label}: ${message}` }], details: { reminderId: id } };
    },
  });

  const list = defineTool({
    name: "list_reminders",
    description: "List pending, fired, and cancelled reminders for this root conversation.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api: ToolExecutionApi, ctx: Context) => {
      rootOnly(api);
      const reminders = await api.snapshot(ReminderState, api.conversationId, ctx);
      const items = Object.values(reminders?.items ?? {}).sort((a, b) => a.when - b.when);
      if (!items.length) return { content: [{ type: "text" as const, text: "No reminders." }] };
      return { content: [{ type: "text" as const, text: items.map((item) => `${item.id}\t${item.status}\t${new Date(item.when).toISOString()}\t${item.message}`).join("\n") }] };
    },
  });

  const cancel = defineTool({
    name: "cancel_reminder",
    description: "Cancel a pending reminder by its ID from list_reminders.",
    parameters: Type.Object({ id: Type.String({ minLength: 1 }) }),
    replay: "safe",
    execute: async (args: { id: string }, api: ToolExecutionApi, ctx: Context) => {
      rootOnly(api);
      let taskId: number | undefined;
      let changed = false;
      await api.commit(async (tx) => {
        const reminders = await tx.doc(ReminderState, api.conversationId);
        const item = reminders.items[args.id];
        if (!item) throw new Error(`No reminder ${args.id}`);
        if (item.status !== "pending") return;
        item.status = "cancelled";
        taskId = item.taskId;
        changed = true;
      }, ctx);
      if (changed && taskId !== undefined) await options.abortTask?.(taskId).catch(() => {});
      return { content: [{ type: "text" as const, text: changed ? `Reminder ${args.id} cancelled.` : `Reminder ${args.id} is already ${((await api.snapshot(ReminderState, api.conversationId, ctx))?.items[args.id]?.status ?? "unavailable")}.` }] };
    },
  });

  return defineExtension({ name: "remind", tasks: [reminderTask], tools: [remind, list, cancel] });
}
