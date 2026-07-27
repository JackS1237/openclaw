import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pinSoleAgentWorkspaceForFleetExpansion } from "./agent-workspace-ownership.js";
import { materializeLegacyDefaultAgentRoles } from "./legacy.default-agent-roles.js";
import type { OpenClawConfig } from "./types.openclaw.js";

describe("agent workspace plugin ownership", () => {
  afterEach(() => vi.restoreAllMocks());

  it("canonicalizes and pins a legacy list during sole-to-fleet expansion", () => {
    const sourceConfig: OpenClawConfig = {
      agents: { defaults: { workspace: "/srv/shared" }, list: [{ id: "ops" }] },
    };
    const targetConfig: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/srv/shared" },
        list: [{ id: "ops" }, { id: "research" }],
      },
    };

    const pinned = pinSoleAgentWorkspaceForFleetExpansion({
      sourceConfig,
      targetConfig,
      agentId: "ops",
    });

    expect(pinned.config.agents?.list).toBeUndefined();
    expect(pinned.config.agents?.entries).toEqual({
      ops: { workspace: "/srv/shared" },
      research: {},
    });
    expect(pinned.insertedPaths).toContainEqual(["agents", "entries", "ops", "workspace"]);
  });

  it.each([
    ["null plugins", null],
    ["null plugins.load", { load: null }],
  ])("preserves malformed %s while pinning a workspace", (_label, plugins) => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const malformedPlugins = plugins as unknown as OpenClawConfig["plugins"];
    const sourceConfig: OpenClawConfig = {
      agents: { defaults: { workspace: "/srv/shared" }, entries: { ops: {} } },
    };
    const targetConfig: OpenClawConfig = {
      agents: { defaults: { workspace: "/srv/shared" }, entries: { ops: {}, research: {} } },
      plugins: malformedPlugins,
    };

    const pinned = pinSoleAgentWorkspaceForFleetExpansion({
      sourceConfig,
      targetConfig,
      agentId: "ops",
    });
    expect(pinned.config.plugins).toBe(malformedPlugins);
    expect(pinned.pluginPath).toBeUndefined();
    expect(pinned.insertedPaths).not.toContainEqual(["plugins", "load", "paths"]);

    const migrated = materializeLegacyDefaultAgentRoles(targetConfig, "ops", {
      materializeWorkspace: true,
    });
    expect(migrated.config.plugins).toBe(malformedPlugins);
    expect(migrated.insertedPaths).not.toContainEqual(["plugins", "load", "paths"]);
  });
});
