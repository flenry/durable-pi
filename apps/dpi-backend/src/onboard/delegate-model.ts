// Delegation model override: DPI_DELEGATE_MODEL makes every worker delegated inside pi-durable
// (delegate children and ticket-slice children) run one configured model, without touching the
// root conversation's model or plain pi's expert configuration. Unset preserves the expert's own
// configured model, so this stays opt-in per device.
//
//   DPI_DELEGATE_MODEL=openrouter/deepseek/deepseek-v4.1-flash-1017

export interface DelegatedModelRef {
  provider: string;
  modelId: string;
}

/** Split `<provider>/<modelId>`; modelId may contain slashes (e.g. openrouter vendor prefixes). */
export function parseDelegateModel(raw: string | undefined): DelegatedModelRef | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const slash = value.indexOf("/");
  const provider = value.slice(0, slash);
  const modelId = value.slice(slash + 1);
  if (slash < 1 || !modelId.trim())
    throw Error(`DPI_DELEGATE_MODEL must be <provider>/<modelId>, got ${value}`);
  return { provider, modelId };
}

/**
 * Precedence for a delegated child's model: an explicit per-child model wins, then the device-wide
 * DPI_DELEGATE_MODEL, then the expert's own configured model. Today no tool passes an explicit
 * per-child model, so the override and the expert config decide; keeping the parameter documents
 * and tests the order for whenever a per-child choice is added.
 */
export function delegatedModel(
  explicit: DelegatedModelRef | undefined,
  configured: DelegatedModelRef | undefined,
  expert: DelegatedModelRef,
): DelegatedModelRef {
  return explicit ?? configured ?? expert;
}
