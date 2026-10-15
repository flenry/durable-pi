import { randomUUID } from "node:crypto";
import { defineTask, type Task, type TaskRuntime } from "@earendil-works/pi-durable";
import type { Ticket, TicketCheckpoint, TicketRunInput, TicketRunResult, TicketStore, ProcessRunner } from "./tickets.js";
import { boundedRunner, TICKET_SCHEDULER_TASK_NAME, validateTicketRepo } from "./tickets.js";

const HOUR_MS = 60 * 60 * 1000;

export function nextTopOfHour(now: number): number {
  return Math.ceil(now / HOUR_MS) * HOUR_MS;
}

export function hourStamp(now: number): string {
  return new Date(Math.floor(now / HOUR_MS) * HOUR_MS).toISOString();
}

export async function selectReadyTicket(
  tickets: Ticket[],
  device: string,
  validate: (ticket: Ticket) => Promise<string | undefined>,
): Promise<{ ticket?: Ticket; skipped: { ticketId: string; reason: string }[] }> {
  const skipped: { ticketId: string; reason: string }[] = [];
  const ordered = [...tickets].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const ticket of ordered) {
    if (ticket.status !== "ready" || ticket.device !== device) continue;
    const reason = await validate(ticket);
    if (reason) skipped.push({ ticketId: ticket.id, reason });
    else return { ticket, skipped };
  }
  return { skipped };
}

type SchedulerCheckpoint =
  | { phase: "wait"; nextAt: number }
  | { phase: "record"; nextAt: number; hour?: string; ticketId?: string; runTaskId?: number };
interface SchedulerInput { device: string }
interface SchedulerResult { stopped: boolean }
type SchedulerRuntime = TaskRuntime<SchedulerInput, SchedulerCheckpoint, SchedulerResult, object>;

export function createTicketSchedulerTask(options: {
  store: TicketStore;
  runTask: Task<TicketRunInput, TicketCheckpoint, TicketRunResult, object>;
  device: string;
  enabled: boolean;
  process?: ProcessRunner;
  now?: () => number;
  timer?: (deadline: number, signal?: AbortSignal) => Promise<void>;
}) {
  const process = options.process ?? boundedRunner;
  const now = options.now ?? Date.now;
  return defineTask<SchedulerInput, SchedulerCheckpoint, SchedulerResult>({
    name: TICKET_SCHEDULER_TASK_NAME,
    version: 1,
    initial: () => ({ phase: "wait", nextAt: nextTopOfHour(now()) }),
    phases: {
      wait: async (task, runtime, ctx) => {
        if (!options.enabled) {
          await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { stopped: true } } }), ctx);
          return;
        }
        if (options.timer) await options.timer(task.state.checkpoint.nextAt, runtime.signal);
        else await runtime.sleep(task.state.checkpoint.nextAt, ctx);
        const hour = hourStamp(now());
        if (await options.store.wasHourProcessed(hour)) {
          await runtime.commit(() => ({
            status: "running",
            checkpoint: { phase: "wait", nextAt: nextTopOfHour(now() + 1) },
          }), ctx);
          return;
        }

        let ticketId: string | undefined;
        let runTaskId: number | undefined;
        const tickets = await options.store.list();
        const active = tickets.find((ticket) => ticket.status === "in-progress" && ticket.device === options.device);
        if (!active) {
          const selected = await selectReadyTicket(tickets, options.device, (ticket) => validateTicketRepo(ticket.repo, process, runtime.signal));
          for (const skipped of selected.skipped)
            await options.store.log(skipped.ticketId, `scheduler skipped invalid repo: ${skipped.reason}`, now());
          ticketId = selected.ticket?.id;
        }

        await runtime.commit(async (tx) => {
          if (ticketId) {
            runTaskId = await tx.createTask(options.runTask, { ticketId, device: options.device, runToken: randomUUID() }, {
              ownership: { kind: "conversation" },
              background: true,
            }) as number;
          }
          return {
            status: "running",
            checkpoint: {
              phase: "record",
              nextAt: nextTopOfHour(now() + 1),
              hour,
              ...(ticketId ? { ticketId } : {}),
              ...(runTaskId ? { runTaskId } : {}),
            },
          };
        }, ctx);
      },
      record: async (task, runtime, ctx) => {
        const checkpoint = task.state.checkpoint;
        if (checkpoint.hour) {
          await options.store.recordHour(checkpoint.hour);
          if (checkpoint.ticketId) await options.store.log(checkpoint.ticketId, `scheduler started run task ${checkpoint.runTaskId ?? "(pending)"} for ${checkpoint.hour}`, now());
        }
        await runtime.commit(() => ({
          status: "running",
          checkpoint: { phase: "wait", nextAt: checkpoint.nextAt },
        }), ctx);
      },
    },
    abort: async (_task, runtime, ctx) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "Scheduler stopped" } }), ctx);
    },
  });
}
