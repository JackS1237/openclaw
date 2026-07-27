import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import type { OpenClawConfig } from "./types.openclaw.js";

const legacyDefaultAgentIdByConfig = new WeakMap<object, string>();
const legacyOwnershipWarningsByConfig = new WeakMap<object, LegacyAgentOwnershipWarning[]>();

type LegacyAgentOwnershipWarning = {
  path: string;
  message: string;
};

/** Retains the retired marker's owner only for the in-process upgrade migration window. */
export function retainLegacyDefaultAgentId(
  config: OpenClawConfig,
  agentId: string | undefined,
  options: {
    warnings?: readonly LegacyAgentOwnershipWarning[];
  } = {},
): OpenClawConfig {
  if (agentId) {
    legacyDefaultAgentIdByConfig.set(config, normalizeAgentId(agentId));
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
    warnings: legacyOwnershipWarningsByConfig.get(source),
  });
}

/** Reads the retired owner without restoring it to the public config shape. */
export function tryGetLegacyDefaultAgentId(config: OpenClawConfig): string | undefined {
  return legacyDefaultAgentIdByConfig.get(config);
}

/** Adds per-surface warnings while a legacy first-entry owner is retained. */
export function appendLegacyOwnershipWarnings(
  config: OpenClawConfig,
  warnings: readonly LegacyAgentOwnershipWarning[],
): void {
  if (!legacyDefaultAgentIdByConfig.has(config) || warnings.length === 0) {
    return;
  }
  legacyOwnershipWarningsByConfig.set(config, [
    ...(legacyOwnershipWarningsByConfig.get(config) ?? []),
    ...warnings,
  ]);
}

export function listLegacyOwnershipWarnings(config: OpenClawConfig): LegacyAgentOwnershipWarning[] {
  return [...(legacyOwnershipWarningsByConfig.get(config) ?? [])];
}
