import type { AgentSummary } from "@sdk/api";
import { DpiError } from "../../../../../dpi-sdk/src/errors.js";

export const isBusyCloseError = (error: unknown) =>
  error instanceof DpiError && error.code === "busy";

const parentId = (agent: AgentSummary) => agent.parentId ?? agent.ownerAgentId;

/** Open idle descendants that can be closed without aborting any work. */
export function closableChildren(
  agents: readonly AgentSummary[],
  rootId: number,
): AgentSummary[] {
  const descendants = new Set<number>();
  const pending = [rootId];
  while (pending.length) {
    const parent = pending.pop()!;
    for (const agent of agents) {
      if (parentId(agent) !== parent || descendants.has(agent.id)) continue;
      descendants.add(agent.id);
      pending.push(agent.id);
    }
  }
  return agents.filter((agent) => {
    if (!descendants.has(agent.id) || agent.kind === "root" || agent.closed || agent.busy) return false;
    const seen = new Set<number>();
    const todo = [agent.id];
    while (todo.length) {
      const parent = todo.pop()!;
      for (const child of agents) {
        if (parentId(child) !== parent || seen.has(child.id)) continue;
        seen.add(child.id);
        if (child.busy) return false;
        todo.push(child.id);
      }
    }
    return true;
  });
}

/** Find the first open ancestor outside the subtree being closed. */
export function parentAfterClosing(
  agents: readonly AgentSummary[],
  selectedAgentId: number,
  closedAgentId: number,
): number | undefined {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const chain: AgentSummary[] = [];
  const seen = new Set<number>();
  let current: AgentSummary | undefined = byId.get(selectedAgentId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    const parent = parentId(current);
    current = parent === undefined ? undefined : byId.get(parent);
  }
  const closingAt = chain.findIndex((agent) => agent.id === closedAgentId);
  return closingAt < 0 ? undefined : chain[closingAt + 1]?.id;
}

/** Find the nearest surviving parent after a selected agent disappears from a stream snapshot. */
export function parentAfterDisappearance(
  previousAgents: readonly AgentSummary[],
  selectedAgentId: number,
  visibleAgentIds: ReadonlySet<number>,
): number | undefined {
  const byId = new Map(previousAgents.map((agent) => [agent.id, agent]));
  const seen = new Set<number>();
  let current: AgentSummary | undefined = byId.get(selectedAgentId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = parentId(current);
    if (parent === undefined) return undefined;
    if (visibleAgentIds.has(parent)) return parent;
    current = byId.get(parent);
  }
  return undefined;
}

/**
 * Keep a closed-inclusive snapshot current with the default live tree. The stream omits closed
 * branches, so a newly missing top-level branch is marked closed while its hidden descendants keep
 * their own persisted `closed` value.
 */
export function mergeClosedAgents(
  allAgents: readonly AgentSummary[],
  visibleAgents: readonly AgentSummary[],
): AgentSummary[] {
  const visibleById = new Map(visibleAgents.map((agent) => [agent.id, agent]));
  const visibleIds = new Set(visibleById.keys());
  const newlyClosed = new Set(
    allAgents
      .filter((agent) => {
        if (visibleIds.has(agent.id) || agent.kind === "root") return false;
        const parent = parentId(agent);
        return parent === undefined || visibleIds.has(parent);
      })
      .map((agent) => agent.id),
  );
  const merged = allAgents.map((agent) => {
    const visible = visibleById.get(agent.id);
    if (visible) return visible;
    return newlyClosed.has(agent.id) ? { ...agent, closed: true } : agent;
  });
  const knownIds = new Set(allAgents.map((agent) => agent.id));
  for (const visible of visibleAgents) if (!knownIds.has(visible.id)) merged.push(visible);
  return merged;
}
