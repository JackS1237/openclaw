import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries } from "../agents/agent-scope-config.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace-default.js";
import { normalizeRouteBindingChannelId } from "../routing/binding-scope.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { isRecord, resolveUserPath } from "../utils.js";
import type { AgentRouteBinding } from "./types.agents.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export type LegacyDefaultAgentRoleMaterialization = {
  config: OpenClawConfig;
  changes: string[];
};

function listAmbientConfiguredChannelIds(cfg: OpenClawConfig): string[] {
  if (!isRecord(cfg.channels)) {
    return [];
  }
  return Object.entries(cfg.channels)
    .flatMap(([channelId, value]) => {
      if (channelId === "defaults" || (isRecord(value) && value.enabled === false)) {
        return [];
      }
      const normalized = normalizeRouteBindingChannelId(channelId);
      return normalized ? [normalized] : [];
    })
    .toSorted((left, right) => left.localeCompare(right));
}

function isChannelWideBinding(binding: AgentRouteBinding, channelId: string): boolean {
  const match = binding.match;
  if (!isRecord(match)) {
    return false;
  }
  return (
    normalizeRouteBindingChannelId(
      typeof match.channel === "string" ? match.channel : undefined,
    ) === channelId &&
    (typeof match.accountId === "string" ? match.accountId.trim() : undefined) === "*" &&
    match.peer === undefined &&
    !normalizeOptionalString(typeof match.guildId === "string" ? match.guildId : undefined) &&
    !normalizeOptionalString(typeof match.teamId === "string" ? match.teamId : undefined) &&
    (!Array.isArray(match.roles) || match.roles.length === 0)
  );
}

export function listUnboundAmbientChannelIds(cfg: OpenClawConfig): string[] {
  if (cfg.bindings !== undefined && !Array.isArray(cfg.bindings)) {
    return [];
  }
  const bindings = Array.isArray(cfg.bindings)
    ? cfg.bindings.filter(
        (binding): binding is AgentRouteBinding => isRecord(binding) && binding.type !== "acp",
      )
    : [];
  return listAmbientConfiguredChannelIds(cfg).filter(
    (channelId) => !bindings.some((binding) => isChannelWideBinding(binding, channelId)),
  );
}

/** Materializes the retired marker's ambient roles before the marker is stripped. */
export function materializeLegacyDefaultAgentRoles(
  cfg: OpenClawConfig,
  legacyDefaultAgentId: string,
  options: { materializeWorkspace?: boolean; env?: NodeJS.ProcessEnv } = {},
): LegacyDefaultAgentRoleMaterialization {
  const defaultAgentId = normalizeAgentId(legacyDefaultAgentId);
  let next = cfg;
  const changes: string[] = [];
  const missingChannelBindings = listUnboundAmbientChannelIds(cfg);
  if (options.materializeWorkspace) {
    const entries = { ...next.agents?.entries };
    const entryKey = Object.keys(entries).find(
      (candidate) => normalizeAgentId(candidate) === defaultAgentId,
    );
    const entry = entryKey ? entries[entryKey] : undefined;
    if (entry) {
      const configuredWorkspace = normalizeOptionalString(entry.workspace);
      const workspace =
        configuredWorkspace ??
        normalizeOptionalString(next.agents?.defaults?.workspace) ??
        resolveDefaultAgentWorkspaceDir(options.env);
      if (!configuredWorkspace) {
        entries[entryKey!] = { ...entry, workspace };
        changes.push(
          `Pinned the retired default agent "${defaultAgentId}" to its current workspace.`,
        );
      }
      const pluginPath = path.join(
        resolveUserPath(workspace, options.env),
        ".openclaw",
        "extensions",
      );
      const rawPluginPaths = next.plugins?.load?.paths;
      const pluginPaths = Array.isArray(rawPluginPaths) ? rawPluginPaths : [];
      const canMaterializePluginPath =
        rawPluginPaths === undefined || Array.isArray(rawPluginPaths);
      const preservePluginPath = canMaterializePluginPath && fs.existsSync(pluginPath);
      next = {
        ...next,
        agents: { ...next.agents, entries },
        ...(preservePluginPath
          ? {
              plugins: {
                ...next.plugins,
                load: {
                  ...next.plugins?.load,
                  paths: pluginPaths.includes(pluginPath)
                    ? pluginPaths
                    : [...pluginPaths, pluginPath],
                },
              },
            }
          : {}),
      };
      if (preservePluginPath) {
        changes.push(`Preserved workspace plugin discovery at "${pluginPath}".`);
      }
    }
  }
  if (missingChannelBindings.length > 0) {
    next = {
      ...next,
      bindings: [
        ...(Array.isArray(next.bindings) ? next.bindings : []),
        ...missingChannelBindings.map((channel) => ({
          agentId: defaultAgentId,
          match: { channel, accountId: "*" },
        })),
      ],
    };
    changes.push(
      `Bound ${missingChannelBindings.join(", ")} unbound account routing to agent "${defaultAgentId}".`,
    );
  }

  const rawDefaults = (cfg.agents as { defaults?: unknown } | undefined)?.defaults;
  const defaultsConfig = isRecord(rawDefaults) ? rawDefaults : undefined;
  const canMaterializeDefaults = rawDefaults === undefined || defaultsConfig !== undefined;
  const hasPerAgentHeartbeat = listAgentEntries(cfg).some((entry) => Boolean(entry.heartbeat));
  // Shared defaults already fan out to every agent; a target would narrow enrollment.
  if (canMaterializeDefaults && !hasPerAgentHeartbeat && defaultsConfig?.heartbeat === undefined) {
    next = {
      ...next,
      agents: {
        ...next.agents,
        defaults: {
          ...next.agents?.defaults,
          heartbeat: { agentId: defaultAgentId },
        },
      },
    };
    changes.push(`Assigned ambient heartbeat runs to agent "${defaultAgentId}".`);
  }

  const rawSystemAgent = defaultsConfig?.systemAgent;
  const systemAgentConfig = isRecord(rawSystemAgent) ? rawSystemAgent : undefined;
  if (
    canMaterializeDefaults &&
    (rawSystemAgent === undefined || systemAgentConfig !== undefined) &&
    (!systemAgentConfig || !Object.hasOwn(systemAgentConfig, "agentId"))
  ) {
    next = {
      ...next,
      agents: {
        ...next.agents,
        defaults: {
          ...next.agents?.defaults,
          systemAgent: {
            ...next.agents?.defaults?.systemAgent,
            agentId: defaultAgentId,
          },
        },
      },
    };
    changes.push(`Assigned ambient system-agent consults to agent "${defaultAgentId}".`);
  }

  const talkConfig = isRecord(cfg.talk) ? cfg.talk : undefined;
  if (
    (cfg.talk === undefined || talkConfig !== undefined) &&
    (!talkConfig || !Object.hasOwn(talkConfig, "agentId"))
  ) {
    next = {
      ...next,
      talk: { ...talkConfig, agentId: defaultAgentId },
    };
    changes.push(`Assigned ambient Talk sessions to agent "${defaultAgentId}".`);
  }

  return { config: next, changes };
}
