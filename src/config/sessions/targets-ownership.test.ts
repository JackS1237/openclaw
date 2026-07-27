import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { retainLegacyDefaultAgentId } from "../legacy.default-agent-owner.js";
import { resolveSessionStoreCompatibilityAgentId, resolveSessionStoreTargets } from "./targets.js";

describe("fixed session store ownership", () => {
  it("does not derive the compatibility anchor from roster shape", () => {
    expect(
      resolveSessionStoreCompatibilityAgentId({
        agents: { entries: { ops: {}, main: {} } },
      }),
    ).toBe("main");
    expect(
      resolveSessionStoreCompatibilityAgentId({
        agents: { entries: { ops: {} } },
      }),
    ).toBe("main");
  });

  it("keeps a colliding target on the retained legacy owner", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") };
      const storePath = path.join(home, "ops.json");
      const diagnostics: string[] = [];
      const cfg = retainLegacyDefaultAgentId(
        {
          session: { store: storePath },
          agents: { entries: { main: {}, ops: {} } },
        },
        "ops",
      );

      expect(resolveSessionStoreTargets(cfg, { allAgents: true }, { env, diagnostics })).toEqual([
        { agentId: "main", storePath },
        { agentId: "ops", storePath },
      ]);
      expect(diagnostics).toContainEqual(expect.stringContaining('suffixed owner(s): "main"'));
    });
  });
});
