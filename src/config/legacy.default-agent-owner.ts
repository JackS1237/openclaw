import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import type { OpenClawConfig } from "./types.openclaw.js";

const legacyDefaultAgentIdByConfig = new WeakMap<object, string>();

/** Retains the retired marker's owner only for the in-process upgrade migration window. */
export function retainLegacyDefaultAgentId(
  config: OpenClawConfig,
  agentId: string | undefined,
): OpenClawConfig {
  if (agentId) {
    legacyDefaultAgentIdByConfig.set(config, normalizeAgentId(agentId));
  }
  return config;
}

/** Carries upgrade-only ownership metadata across runtime config materialization. */
export function inheritLegacyDefaultAgentId(
  source: OpenClawConfig,
  target: OpenClawConfig,
): OpenClawConfig {
  return retainLegacyDefaultAgentId(target, tryGetLegacyDefaultAgentId(source));
}

/** Reads the retired owner without restoring it to the public config shape. */
export function tryGetLegacyDefaultAgentId(config: OpenClawConfig): string | undefined {
  return legacyDefaultAgentIdByConfig.get(config);
}
