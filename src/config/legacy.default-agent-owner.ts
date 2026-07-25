import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import type { OpenClawConfig } from "./types.openclaw.js";

const legacyDefaultAgentIdByConfig = new WeakMap<object, string>();
const provisionalLegacyDefaultConfigs = new WeakSet<object>();
const unconditionalLegacyDefaultConfigs = new WeakSet<object>();
const legacyOwnershipWarningsByConfig = new WeakMap<object, LegacyAgentOwnershipWarning[]>();

export type LegacyAgentOwnershipWarning = {
  path: string;
  message: string;
};

/** Retains the retired marker's owner only for the in-process upgrade migration window. */
export function retainLegacyDefaultAgentId(
  config: OpenClawConfig,
  agentId: string | undefined,
  options: {
    provisional?: boolean;
    warnings?: readonly LegacyAgentOwnershipWarning[];
  } = {},
): OpenClawConfig {
  if (agentId) {
    legacyDefaultAgentIdByConfig.set(config, normalizeAgentId(agentId));
  }
  if (options.provisional && !unconditionalLegacyDefaultConfigs.has(config)) {
    provisionalLegacyDefaultConfigs.add(config);
  } else if (agentId && !options.provisional) {
    unconditionalLegacyDefaultConfigs.add(config);
    provisionalLegacyDefaultConfigs.delete(config);
  }
  if (options.warnings && options.warnings.length > 0) {
    legacyOwnershipWarningsByConfig.set(config, [...options.warnings]);
  }
  return config;
}

/** Carries upgrade-only ownership metadata across runtime config materialization. */
export function inheritLegacyDefaultAgentId(
  source: OpenClawConfig,
  target: OpenClawConfig,
): OpenClawConfig {
  return retainLegacyDefaultAgentId(target, tryGetLegacyDefaultAgentId(source), {
    provisional:
      provisionalLegacyDefaultConfigs.has(source) && !unconditionalLegacyDefaultConfigs.has(source),
    warnings: legacyOwnershipWarningsByConfig.get(source),
  });
}

/** Reads the retired owner without restoring it to the public config shape. */
export function tryGetLegacyDefaultAgentId(config: OpenClawConfig): string | undefined {
  return legacyDefaultAgentIdByConfig.get(config);
}

/** Adds per-surface warnings while a marker-free first-entry owner is provisional. */
export function appendProvisionalLegacyOwnershipWarnings(
  config: OpenClawConfig,
  warnings: readonly LegacyAgentOwnershipWarning[],
): void {
  if (!provisionalLegacyDefaultConfigs.has(config) || warnings.length === 0) {
    return;
  }
  legacyOwnershipWarningsByConfig.set(config, [
    ...(legacyOwnershipWarningsByConfig.get(config) ?? []),
    ...warnings,
  ]);
}

/** Drops a marker-free candidate once every currently active surface is explicit. */
export function finalizeProvisionalLegacyDefaultAgent(config: OpenClawConfig): void {
  if (
    provisionalLegacyDefaultConfigs.has(config) &&
    (legacyOwnershipWarningsByConfig.get(config)?.length ?? 0) === 0
  ) {
    legacyDefaultAgentIdByConfig.delete(config);
    provisionalLegacyDefaultConfigs.delete(config);
  }
}

export function listLegacyOwnershipWarnings(config: OpenClawConfig): LegacyAgentOwnershipWarning[] {
  return [...(legacyOwnershipWarningsByConfig.get(config) ?? [])];
}
