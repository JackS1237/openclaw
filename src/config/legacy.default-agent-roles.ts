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
  warnings: Array<{ path: string; message: string }>;
  insertedPaths: string[][];
};

function readVoiceCallPluginConfig(cfg: OpenClawConfig): Record<string, unknown> | undefined {
  const config = cfg.plugins?.entries?.["voice-call"]?.config;
  return isRecord(config) ? config : undefined;
}

function listAmbientConfiguredChannelIds(
  cfg: OpenClawConfig,
  ambientChannelIds: readonly string[] = [],
): string[] {
  const configured = isRecord(cfg.channels)
    ? Object.entries(cfg.channels).flatMap(([channelId, value]) => {
        if (channelId === "defaults" || (isRecord(value) && value.enabled === false)) {
          return [];
        }
        const normalized = normalizeRouteBindingChannelId(channelId);
        return normalized ? [normalized] : [];
      })
    : [];
  return [
    ...new Set([
      ...configured,
      ...ambientChannelIds.flatMap((channelId) => {
        const normalized = normalizeRouteBindingChannelId(channelId);
        return normalized ? [normalized] : [];
      }),
    ]),
  ].toSorted((left, right) => left.localeCompare(right));
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

export function listUnboundAmbientChannelIds(
  cfg: OpenClawConfig,
  ambientChannelIds: readonly string[] = [],
): string[] {
  if (cfg.bindings !== undefined && !Array.isArray(cfg.bindings)) {
    return [];
  }
  const bindings = Array.isArray(cfg.bindings)
    ? cfg.bindings.filter(
        (binding): binding is AgentRouteBinding => isRecord(binding) && binding.type !== "acp",
      )
    : [];
  return listAmbientConfiguredChannelIds(cfg, ambientChannelIds).filter(
    (channelId) => !bindings.some((binding) => isChannelWideBinding(binding, channelId)),
  );
}

/** Materializes the retired marker's ambient roles before the marker is stripped. */
export function materializeLegacyDefaultAgentRoles(
  cfg: OpenClawConfig,
  legacyDefaultAgentId: string,
  options: {
    materializeWorkspace?: boolean;
    env?: NodeJS.ProcessEnv;
    ambientChannelIds?: readonly string[];
  } = {},
): LegacyDefaultAgentRoleMaterialization {
  const defaultAgentId = normalizeAgentId(legacyDefaultAgentId);
  let next = cfg;
  const changes: string[] = [];
  const warnings: Array<{ path: string; message: string }> = [];
  const insertedPaths: string[][] = [];
  const missingChannelBindings = listUnboundAmbientChannelIds(cfg, options.ambientChannelIds);
  if (options.materializeWorkspace) {
    const entries = { ...next.agents?.entries };
    const entryKey = Object.keys(entries).find(
      (candidate) => normalizeAgentId(candidate) === defaultAgentId,
    );
    const entry = entryKey ? entries[entryKey] : undefined;
    if (entry) {
      const configuredWorkspace = normalizeOptionalString(entry.workspace);
      const workspaceNeedsPin =
        !Object.hasOwn(entry, "workspace") ||
        (typeof entry.workspace === "string" && entry.workspace.trim().length === 0);
      const workspace =
        configuredWorkspace ??
        normalizeOptionalString(next.agents?.defaults?.workspace) ??
        resolveDefaultAgentWorkspaceDir(options.env);
      // An authored-but-malformed value must survive until schema validation.
      if (workspaceNeedsPin) {
        entries[entryKey!] = { ...entry, workspace };
        insertedPaths.push(["agents", "entries", entryKey!, "workspace"]);
        changes.push(
          `Pinned the retired default agent "${defaultAgentId}" to its current workspace.`,
        );
        warnings.push({
          path: `agents.entries.${entryKey}.workspace`,
          message: `legacy marker-free fleet temporarily keeps agent "${defaultAgentId}" in its sole-agent workspace; set agents.entries.${entryKey}.workspace explicitly or run "openclaw doctor --fix"`,
        });
      }
      const pluginPath =
        workspaceNeedsPin || configuredWorkspace
          ? path.join(resolveUserPath(workspace, options.env), ".openclaw", "extensions")
          : undefined;
      const rawPlugins = next.plugins as unknown;
      const rawPluginLoad = isRecord(rawPlugins) ? rawPlugins.load : undefined;
      const rawPluginPaths = isRecord(rawPluginLoad) ? rawPluginLoad.paths : undefined;
      const pluginPaths = Array.isArray(rawPluginPaths) ? rawPluginPaths : [];
      const canMaterializePluginPath =
        (rawPlugins === undefined || isRecord(rawPlugins)) &&
        (rawPluginLoad === undefined || isRecord(rawPluginLoad)) &&
        (rawPluginPaths === undefined || Array.isArray(rawPluginPaths));
      const preservePluginPath =
        pluginPath !== undefined && canMaterializePluginPath && fs.existsSync(pluginPath);
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
      if (preservePluginPath && pluginPath) {
        if (!pluginPaths.includes(pluginPath)) {
          insertedPaths.push(["plugins", "load", "paths"]);
        }
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
    insertedPaths.push(["bindings"]);
    for (const channelId of missingChannelBindings) {
      warnings.push({
        path: `channels.${channelId}`,
        message: `legacy marker-free fleet temporarily routes unmatched ${channelId} traffic to first roster agent "${defaultAgentId}"; run "openclaw agents bind --agent ${defaultAgentId} --bind ${channelId}:*" or "openclaw doctor --fix"`,
      });
    }
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
    insertedPaths.push(["agents", "defaults", "heartbeat", "agentId"]);
    warnings.push({
      path: "agents.defaults.heartbeat.agentId",
      message: `legacy marker-free fleet temporarily assigns ambient heartbeat runs to first roster agent "${defaultAgentId}"; set agents.defaults.heartbeat.agentId or run "openclaw doctor --fix"`,
    });
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
    insertedPaths.push(["agents", "defaults", "systemAgent", "agentId"]);
    warnings.push({
      path: "agents.defaults.systemAgent.agentId",
      message: `legacy marker-free fleet temporarily assigns system-agent consults to first roster agent "${defaultAgentId}"; set agents.defaults.systemAgent.agentId or run "openclaw doctor --fix"`,
    });
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
    insertedPaths.push(["talk", "agentId"]);
    warnings.push({
      path: "talk.agentId",
      message: `legacy marker-free fleet temporarily assigns Talk sessions to first roster agent "${defaultAgentId}"; set talk.agentId or run "openclaw doctor --fix"`,
    });
  }

  const voiceCallEntry = cfg.plugins?.entries?.["voice-call"];
  const voiceCallConfig = readVoiceCallPluginConfig(cfg);
  if (
    voiceCallEntry?.enabled !== false &&
    voiceCallConfig?.enabled === true &&
    voiceCallConfig !== undefined &&
    !Object.hasOwn(voiceCallConfig, "agentId")
  ) {
    next = {
      ...next,
      plugins: {
        ...next.plugins,
        entries: {
          ...next.plugins?.entries,
          "voice-call": {
            ...voiceCallEntry,
            config: { ...voiceCallConfig, agentId: defaultAgentId },
          },
        },
      },
    };
    changes.push(`Assigned ambient voice-call sessions to agent "${defaultAgentId}".`);
    insertedPaths.push(["plugins", "entries", "voice-call", "config", "agentId"]);
    warnings.push({
      path: "plugins.entries.voice-call.config.agentId",
      message: `legacy marker-free fleet temporarily assigns voice-call sessions to first roster agent "${defaultAgentId}"; set plugins.entries.voice-call.config.agentId or run "openclaw doctor --fix"`,
    });
  }

  return { config: next, changes, warnings, insertedPaths };
}
