<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Network, PanelLeftClose, PanelLeftOpen } from "lucide-vue-next";
import DeviceIcon from "./DeviceIcon.vue";
import type { DeviceTree } from "@sdk/api";
import { networkTree, type TreeNode } from "@sdk/models";
import TreeRow from "./TreeRow.vue";
import { deviceClient, hub, message } from "../client/hub";
import {
  isBusyCloseError,
  mergeClosedAgents,
  parentAfterClosing,
} from "../client/agent-close";
import {
  attempt,
  expanded,
  layout,
  network,
  notify,
  select,
  selected,
  toggle,
  ui,
  panelKeys,
  sessionAgents,
  showClosedAgents,
} from "../client/store";

interface Row {
  node: TreeNode;
  depth: number;
  parent?: string;
}

const closedTrees = ref(new Map<string, DeviceTree>());
const pendingAgents = ref(new Set<string>());
const displayTree = computed(() =>
  networkTree(
    network.devices.value.map((device) => {
      const all = closedTrees.value.get(device.id);
      if (!showClosedAgents.value || !all) return device;
      const live = device.tree;
      const sessions = live
        ? live.sessions.map((session) => {
            const snapshot = all.sessions.find((candidate) => candidate.id === session.id);
            return snapshot
              ? { ...session, agents: mergeClosedAgents(snapshot.agents, session.agents) }
              : session;
          })
        : all.sessions;
      return { ...device, tree: { ...all, ...live, sessions } };
    }),
  ),
);
const rows = computed(() => {
  const out: Row[] = [];
  const walk = (nodes: TreeNode[], depth: number, parent?: string) => {
    for (const node of nodes) {
      out.push({ node, depth, parent });
      if (node.children.length && expanded.value.has(node.key))
        walk(node.children, depth + 1, node.key);
    }
  };
  walk(displayTree.value, 0);
  return out;
});
const focusKey = ref<string>();
const list = ref<HTMLElement>();

const deviceOf = (node: TreeNode) =>
  network.devices.value.find(
    (d) => d.id === (node.type === "device" ? node.device.id : node.deviceId),
  );
const isOnline = (node: TreeNode) => deviceOf(node)?.status === "online";
const deviceStates = computed(() =>
  network.devices.value.map((device) => `${device.id}:${device.status}`).join("|"),
);

async function refreshTree(
  deviceId: string,
  includeClosed = showClosedAgents.value,
  forceDefault = false,
) {
  const tree = await deviceClient(deviceId).tree({ closed: includeClosed });
  if (!forceDefault && showClosedAgents.value !== includeClosed) return;
  if (includeClosed) {
    closedTrees.value = new Map(closedTrees.value).set(deviceId, tree);
  } else {
    network.model.apply({
      type: "network",
      devices: network.devices.value.map((device) =>
        device.id === deviceId ? { ...device, tree } : device,
      ),
    });
  }
}

watch(
  [showClosedAgents, deviceStates],
  ([includeClosed]) => {
    if (!includeClosed) closedTrees.value = new Map();
    for (const device of network.devices.value)
      if (device.status === "online")
        void refreshTree(device.id, includeClosed).catch((error) => (ui.error = message(error)));
  },
  { immediate: true },
);

const isSelected = (node: TreeNode) =>
  node.type === "agent" &&
  selected.value?.deviceId === node.deviceId &&
  selected.value.sessionId === node.sessionId &&
  selected.value.agentId === node.agent.id;

function activate(node: TreeNode) {
  focusKey.value = node.key;
  if (node.type === "device") return toggle(node.key);
  if (node.type === "agent")
    return select({ deviceId: node.deviceId, sessionId: node.sessionId, agentId: node.agent.id });
  const root = node.session.agents.find((a) => a.kind === "root") ?? node.session.agents[0];
  toggle(node.key, true);
  if (root) select({ deviceId: node.deviceId, sessionId: node.session.id, agentId: root.id });
}

function fallBackFromClosedBranch(node: Extract<TreeNode, { type: "agent" }>) {
  const target = selected.value;
  if (
    !target ||
    target.deviceId !== node.deviceId ||
    target.sessionId !== node.sessionId
  )
    return;
  const agents = sessionAgents.value;
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const seen = new Set<number>();
  let current = byId.get(target.agentId);
  let affected = false;
  while (current && !seen.has(current.id)) {
    if (current.id === node.agent.id) {
      affected = true;
      break;
    }
    seen.add(current.id);
    const parent = current.parentId ?? current.ownerAgentId;
    current = parent === undefined ? undefined : byId.get(parent);
  }
  if (!affected) return;
  const parent = parentAfterClosing(agents, target.agentId, node.agent.id);
  select(parent === undefined ? undefined : { ...target, agentId: parent });
}

async function refreshAfterMutation(deviceId: string) {
  try {
    // Refresh the default tree first so a reopened agent is present before merging a closed-inclusive snapshot.
    await refreshTree(deviceId, false, true);
    if (showClosedAgents.value) await refreshTree(deviceId, true);
  } catch (error) {
    ui.error = `Agent updated, but refreshing the tree failed: ${message(error)}`;
  }
}

async function action(node: TreeNode, name: string) {
  const device = deviceOf(node);
  if (!device) return;
  const client = deviceClient(device.id);
  if (node.type === "device") {
    if (name === "new-session") ui.dialog = { kind: "new-session", deviceId: device.id };
    else if (name === "check") await attempt(() => hub.check(device.id));
    return;
  }
  if (node.type === "session") {
    const s = node.session;
    if (name === "new-agent") {
      const created = await attempt(() => client.session(s.id).createAgent({}));
      if (created) {
        select({ deviceId: device.id, sessionId: s.id, agentId: created.id });
        notify("New agent. Same session, same shared App State.");
      }
    } else if (name === "rename")
      ui.dialog = {
        kind: "prompt",
        title: "Rename session",
        label: "Session name",
        value: s.name,
        submit: "Save name",
        run: (value) => client.session(s.id).rename(value),
      };
    else if (name === "archive")
      ui.dialog = {
        kind: "prompt",
        title: `Archive ${s.name}?`,
        hint: `Stops all of its work and moves its files to archive/ on ${device.id}. Nothing is deleted.`,
        submit: "Archive session",
        danger: true,
        run: async () => {
          await client.session(s.id).archive();
          if (selected.value?.sessionId === s.id) select(undefined);
        },
      };
    return;
  }
  const a = node.agent;
  if (name === "close" || name === "reopen") {
    if (pendingAgents.value.has(node.key)) return;
    pendingAgents.value = new Set(pendingAgents.value).add(node.key);
    ui.error = "";
    const handle = client.agent(node.sessionId, a.id);
    const closed = name === "close";
    try {
      await handle.setClosed(closed);
      if (closed) fallBackFromClosedBranch(node);
      await refreshAfterMutation(device.id);
    } catch (error) {
      if (closed && isBusyCloseError(error)) {
        ui.dialog = {
          kind: "prompt",
          title: "Stop and close?",
          hint: `${a.name} or one of its owned agents is still working. Stop the work and close this agent?`,
          submit: "Stop and close",
          danger: true,
          run: async () => {
            await handle.setClosed(true, { abort: true });
            fallBackFromClosedBranch(node);
            await refreshAfterMutation(device.id);
          },
        };
      } else ui.error = message(error);
    } finally {
      const pending = new Set(pendingAgents.value);
      pending.delete(node.key);
      pendingAgents.value = pending;
    }
    return;
  }
  if (name === "rename")
    ui.dialog = {
      kind: "prompt",
      title: "Rename agent",
      label: "Agent name",
      value: a.named ? a.name : "",
      placeholder: a.name,
      submit: "Save name",
      run: (value) => client.agent(node.sessionId, a.id).rename(value),
    };
}

function move(delta: number) {
  const i = rows.value.findIndex((r) => r.node.key === focusKey.value);
  const next = rows.value[Math.max(0, Math.min(rows.value.length - 1, (i < 0 ? 0 : i) + delta))];
  if (!next) return;
  focusKey.value = next.node.key;
  void nextTick(() =>
    list.value
      ?.querySelector(`[data-key="${CSS.escape(next.node.key)}"]`)
      ?.scrollIntoView({ block: "nearest" }),
  );
}

function focusFirst() {
  focusKey.value ??= rows.value[0]?.node.key;
}

function keydown(e: KeyboardEvent) {
  const row = rows.value.find((r) => r.node.key === focusKey.value);
  if (e.key === "ArrowDown") move(1);
  else if (e.key === "ArrowUp") move(-1);
  else if (e.key === "ArrowRight" && row) {
    if (!row.node.children.length) return;
    if (expanded.value.has(row.node.key)) move(1);
    else toggle(row.node.key, true);
  } else if (e.key === "ArrowLeft" && row) {
    if (row.node.children.length && expanded.value.has(row.node.key)) toggle(row.node.key, false);
    else if (row.parent) focusKey.value = row.parent;
  } else if ((e.key === "Enter" || e.key === " ") && row) activate(row.node);
  else return;
  e.preventDefault();
}
</script>

<template>
  <aside
    class="network-sidebar"
    :class="{ open: ui.drawer, collapsed: !layout.tree && !ui.drawer }"
    aria-label="Network"
  >
    <template v-if="layout.tree || ui.drawer">
      <header class="tree-head">
        <span><Network :size="16" />NETWORK</span>
        <label class="show-closed-toggle">
          <input v-model="showClosedAgents" type="checkbox" />
          Show closed
        </label>
        <button
          class="icon-button panel-toggle"
          aria-label="Collapse network"
          :title="`Collapse network (${panelKeys.tree})`"
          @click="((layout.tree = false), (ui.drawer = false))"
        >
          <PanelLeftClose :size="18" />
        </button>
      </header>
      <div
        ref="list"
        class="tree-list"
        role="tree"
        tabindex="0"
        aria-label="Devices, sessions and agents"
        @keydown="keydown"
        @focus="focusFirst"
      >
        <TreeRow
          v-for="row in rows"
          :key="row.node.key"
          :node="row.node"
          :depth="row.depth"
          :open="expanded.has(row.node.key)"
          :selected="isSelected(row.node)"
          :focused="focusKey === row.node.key"
          :online="isOnline(row.node)"
          :action-busy="pendingAgents.has(row.node.key)"
          @toggle="toggle(row.node.key)"
          @activate="activate(row.node)"
          @action="action(row.node, $event)"
        />
        <p v-if="!rows.length" class="hint tree-empty">
          No devices yet. Declare them in <code>dpi-network.yaml</code> (start from
          <code>dpi-network.example.yaml</code>), then run <code>just net up &lt;id&gt;</code>.
        </p>
      </div>
    </template>
    <div v-else class="panel-rail" aria-label="Network (collapsed)">
      <button
        class="icon-button panel-toggle"
        aria-label="Expand network"
        :title="`Expand network (${panelKeys.tree})`"
        @click="layout.tree = true"
      >
        <PanelLeftOpen :size="18" />
      </button>
      <button
        v-for="d in network.devices.value"
        :key="d.id"
        class="rail-device"
        :title="`${d.id} · ${d.status}`"
        :aria-label="`Show ${d.id}`"
        @click="((layout.tree = true), toggle(d.id, true))"
      >
        <DeviceIcon :device="d" :size="20" /><i
          class="dot"
          :class="
            d.status === 'online'
              ? 'on'
              : d.status === 'checking'
                ? 'chk'
                : d.status === 'offline'
                  ? 'off'
                  : 'err'
          "
        />
      </button>
    </div>
  </aside>
</template>
