import fs from "node:fs";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type AgentWorkspaceOwnershipPin = {
  config: OpenClawConfig;
  workspace?: string;
  pluginPath?: string;
  insertedPaths: string[][];
};

/** Pins a sole agent's resolved workspace before a write expands the roster. */
export function pinSoleAgentWorkspaceForFleetExpansion(params: {
  sourceConfig: OpenClawConfig;
  targetConfig: OpenClawConfig;
  agentId: string;
  env?: NodeJS.ProcessEnv;
}): AgentWorkspaceOwnershipPin {
  const agentId = normalizeAgentId(params.agentId);
  const entries = { ...params.targetConfig.agents?.entries };
  const entryKey = Object.keys(entries).find(
    (candidate) => normalizeAgentId(candidate) === agentId,
  );
  const entry = entryKey ? entries[entryKey] : undefined;
  const workspaceIsResolved =
    typeof entry?.workspace === "string" && entry.workspace.trim().length > 0;
  const workspaceIsMalformed =
    entry !== undefined &&
    Object.hasOwn(entry, "workspace") &&
    entry.workspace !== undefined &&
    typeof entry.workspace !== "string";
  if (!entry || workspaceIsResolved || workspaceIsMalformed) {
    return { config: params.targetConfig, insertedPaths: [] };
  }

  // Resolve against the old sole-agent topology. Resolving after the roster
  // expands would silently select the new per-agent workspace instead.
  const workspace = resolveAgentWorkspaceDir(params.sourceConfig, agentId, params.env);
  entries[entryKey!] = { ...entry, workspace };
  const pluginPath = path.join(workspace, ".openclaw", "extensions");
  const rawPluginPaths = params.targetConfig.plugins?.load?.paths;
  const pluginPaths = Array.isArray(rawPluginPaths) ? rawPluginPaths : [];
  const preservePluginPath =
    (rawPluginPaths === undefined || Array.isArray(rawPluginPaths)) && fs.existsSync(pluginPath);
  return {
    config: {
      ...params.targetConfig,
      agents: { ...params.targetConfig.agents, entries },
      ...(preservePluginPath
        ? {
            plugins: {
              ...params.targetConfig.plugins,
              load: {
                ...params.targetConfig.plugins?.load,
                paths: pluginPaths.includes(pluginPath)
                  ? pluginPaths
                  : [...pluginPaths, pluginPath],
              },
            },
          }
        : {}),
    },
    workspace,
    ...(preservePluginPath && !pluginPaths.includes(pluginPath) ? { pluginPath } : {}),
    insertedPaths: [
      ["agents", "entries", entryKey!, "workspace"],
      ...(preservePluginPath && !pluginPaths.includes(pluginPath)
        ? [["plugins", "load", "paths"]]
        : []),
    ],
  };
}
