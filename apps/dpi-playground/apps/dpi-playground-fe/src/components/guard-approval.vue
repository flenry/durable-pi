<script setup lang="ts">
import { ref } from "vue";
import { Check, Info } from "lucide-vue-next";
import type { GuardApprovalState } from "../client/guard-approval";
import { agentHandle, attempt } from "../client/store";
import { newId } from "../client/ids";

const props = defineProps<{ approval: GuardApprovalState }>();
const sendingApproval = ref(false);
const approvalSent = ref(false);

async function approveOnce() {
  const approval = props.approval;
  const handle = agentHandle.value;
  if (approval.status !== "pending" || sendingApproval.value || approvalSent.value || !handle)
    return;

  sendingApproval.value = true;
  try {
    approvalSent.value = Boolean(
      await attempt(() => handle.send(`approve ${approval.request.hash}`, "followUp", newId())),
    );
  } finally {
    sendingApproval.value = false;
  }
}
</script>

<template>
  <section class="guard-approval" aria-label="Destructive command approval">
    <div class="guard-approval-heading">
      <Info :size="18" aria-hidden="true" />
      <span>Destructive command blocked</span>
    </div>
    <code class="guard-approval-command">{{ approval.request.label }}</code>
    <p class="guard-approval-reason">{{ approval.request.reason }}</p>
    <div v-if="approval.status === 'pending'" class="guard-approval-actions">
      <button
        class="guard-approval-button"
        :disabled="sendingApproval || approvalSent || !agentHandle"
        @click="approveOnce"
      >
        <Check v-if="approvalSent" :size="18" aria-hidden="true" />
        {{
          approvalSent ? "Approval sent" : sendingApproval ? "Sending approval…" : "Approve once"
        }}
      </button>
      <span v-if="approvalSent" class="guard-approval-status" aria-live="polite">
        Approval message sent to the root agent.
      </span>
    </div>
    <p v-else-if="approval.status === 'sent'" class="guard-approval-status" aria-live="polite">
      Approval message sent in this conversation.
    </p>
    <p v-else class="guard-approval-status">
      A newer blocked attempt for this command replaces this request.
    </p>
  </section>
</template>
