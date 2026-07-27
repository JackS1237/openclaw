import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeAgentId } from "../routing/session-key.js";

/** Keeps per-agent global-session events isolated while preserving the logical session key. */
export function resolveSystemEventQueueKey(params: {
  sessionKey: string;
  agentId?: string;
}): string {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    throw new Error("system events require a sessionKey");
  }
  const agentId = normalizeOptionalString(params.agentId);
  return sessionKey === "global" && agentId
    ? `agent:${normalizeAgentId(agentId)}:global`
    : sessionKey;
}
