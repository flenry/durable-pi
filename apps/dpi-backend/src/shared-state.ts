import { Harness, createRegistry, defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  changeState,
  replaceState,
  type AppState,
  type StateChange,
} from "../../dpi-sdk/src/app-state.js";

const Data = defineDoc<AppState>({
  kind: "app.shared-state",
  version: 1,
  scope: "session",
  initial: () => ({}),
});
const TicketData = defineDoc<AppState>({
  kind: "app.shared-ticket-state",
  version: 1,
  scope: "session",
  initial: () => ({}),
});
const LEGACY_TICKET_STATE_KEY = "dpi.tickets";
const MAX_TICKET_STATE_CHARS = 85_000;
const Meta = defineDoc<{ initialized: boolean; revision: number; ticketStateMigrated?: boolean }>({
  kind: "app.shared-state-meta",
  version: 1,
  scope: "session",
  initial: () => ({ initialized: false, revision: 0 }),
});
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const Receipts = defineDocFamily<{ applied: boolean; result: string }, null>({
  kind: "app.shared-state-receipt",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ applied: false, result: "" }),
});

export class SharedState {
  private constructor(readonly harness: Harness) {}
  static async open(path: string) {
    return new SharedState(
      await Harness.open(
        await openNodeSqliteStorage(path),
        { models: createModels(), registry: createRegistry() },
        ctx,
      ),
    );
  }
  async initialized() {
    return (await this.harness.snapshot(Meta, ctx))?.initialized === true;
  }
  async initialize(seed: AppState) {
    await this.harness.commit(async (tx) => {
      const meta = await tx.doc(Meta);
      if (meta.initialized) return;
      const data = await tx.doc(Data);
      replaceState(data, seed);
      meta.initialized = true;
    }, ctx);
  }
  async snapshot() {
    return this.harness.commit(async (tx) => {
      const data = await tx.doc(Data);
      const meta = await tx.doc(Meta);
      return { value: JSON.parse(JSON.stringify(data)) as AppState, revision: meta.revision };
    }, ctx);
  }
  /** Run a synchronous mutation against the one device-wide App State document. */
  async transactAppState<T>(change: (state: AppState) => T): Promise<T> {
    return this.harness.commit(async (tx) => {
      const data = await tx.doc(Data);
      const before = JSON.stringify(data);
      const result = change(data);
      const encoded = JSON.stringify(data);
      if (encoded.length > 100_000) throw Error("App State must be under 100,000 characters");
      if (encoded !== before) (await tx.doc(Meta)).revision++;
      if (result === undefined) return result as T;
      return JSON.parse(JSON.stringify(result)) as T;
    }, ctx);
  }
  /** Ticket queue persistence is isolated from user-editable App State so unrelated growth cannot strand leases. */
  async transactTicketState<T>(change: (state: AppState) => T): Promise<T> {
    return this.harness.commit(async (tx) => {
      const meta = await tx.doc(Meta);
      const data = await tx.doc(TicketData);
      if (!meta.ticketStateMigrated) {
        const appState = await tx.doc(Data);
        if (!Object.hasOwn(data, LEGACY_TICKET_STATE_KEY) && Object.hasOwn(appState, LEGACY_TICKET_STATE_KEY)) {
          const legacy = appState[LEGACY_TICKET_STATE_KEY];
          const ticketLike = isRecord(legacy) && legacy.version === 1;
          if (ticketLike) {
            if (!isRecord(legacy.tickets) || !Array.isArray(legacy.processedHours))
              throw Error("Legacy ticket state is invalid; refusing to move user App State data");
            data[LEGACY_TICKET_STATE_KEY] = JSON.parse(JSON.stringify(legacy)) as AppState[string];
            delete appState[LEGACY_TICKET_STATE_KEY];
            meta.revision++;
          }
        }
        meta.ticketStateMigrated = true;
      }
      const result = change(data);
      if (JSON.stringify(data).length > MAX_TICKET_STATE_CHARS)
        throw Error("Ticket state must be under 85,000 characters");
      if (result === undefined) return result as T;
      return JSON.parse(JSON.stringify(result)) as T;
    }, ctx);
  }
  async change(change: StateChange, receiptKey?: string, expectedRevision?: number) {
    return this.harness.commit(async (tx) => {
      const receipt = receiptKey ? await tx.doc(Receipts, receiptKey, null) : undefined;
      if (receipt?.applied) return JSON.parse(receipt.result) as AppState;
      const data = await tx.doc(Data);
      const meta = await tx.doc(Meta);
      if (expectedRevision !== undefined && expectedRevision !== meta.revision)
        throw Error(
          "App State changed while you were editing. Load the latest JSON before saving.",
        );
      const next = changeState(data, change);
      replaceState(data, next);
      meta.revision++;
      if (receipt) {
        receipt.applied = true;
        receipt.result = JSON.stringify(next);
      }
      return next;
    }, ctx);
  }
  async close() {
    await this.harness.close(ctx);
  }
}
