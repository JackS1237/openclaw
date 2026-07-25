import { describe, expect, it } from "vitest";
import { validateConfigObjectWithPlugins } from "./validation.js";
import { AgentsSchema } from "./zod-schema.agents.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("agent roster ownership", () => {
  it("rejects an empty roster after load-time migration", () => {
    expect(AgentsSchema.safeParse({ entries: {} }).success).toBe(false);
  });

  it("accepts sole and multi-agent rosters without a stored default", () => {
    expect(AgentsSchema.safeParse({ entries: { alpha: {} } }).success).toBe(true);
    expect(AgentsSchema.safeParse({ entries: { alpha: {}, beta: {} } }).success).toBe(true);
  });

  it("rejects the retired default marker", () => {
    const result = AgentsSchema.safeParse({ entries: { alpha: { default: true } } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ["entries", "alpha"] }),
      );
    }
  });
});

describe("explicit ambient agent targets", () => {
  it.each([
    {
      agents: {
        defaults: { heartbeat: { agentId: "missing" } },
        entries: { main: {} },
      },
    },
    {
      agents: {
        defaults: { systemAgent: { agentId: "missing" } },
        entries: { main: {} },
      },
    },
    { agents: { entries: { main: {} } }, talk: { agentId: "missing" } },
  ])("rejects an unknown explicit target", (target) => {
    const result = OpenClawSchema.safeParse(target);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("Unknown agent id");
    }
  });

  it("accepts configured heartbeat, system-agent, and Talk targets", () => {
    expect(
      OpenClawSchema.safeParse({
        agents: {
          defaults: {
            heartbeat: { agentId: "ops" },
            systemAgent: { agentId: "ops" },
          },
          entries: { ops: {} },
        },
        talk: { agentId: "ops" },
      }).success,
    ).toBe(true);
  });

  it.each([
    {
      agents: {
        defaults: { heartbeat: { agentId: " " } },
        entries: { main: {} },
      },
    },
    {
      agents: {
        defaults: { systemAgent: { agentId: " " } },
        entries: { main: {} },
      },
    },
    { agents: { entries: { main: {} } }, talk: { agentId: " " } },
  ])("rejects blank explicit targets", (config) => {
    expect(OpenClawSchema.safeParse(config).success).toBe(false);
  });

  it("validates targets against the implicit main roster", () => {
    expect(OpenClawSchema.safeParse({ talk: { agentId: "main" } }).success).toBe(true);
    expect(OpenClawSchema.safeParse({ talk: { agentId: "missing" } }).success).toBe(false);
  });
});

describe("multi-agent ambient ownership warnings", () => {
  it("warns for every ownerless ambient surface without invalidating config", () => {
    const result = validateConfigObjectWithPlugins(
      {
        agents: { entries: { ops: {}, research: {} } },
        channels: { telegram: { enabled: true } },
      },
      { pluginValidation: "skip" },
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.map((warning) => warning.path)).toEqual([
      "channels.telegram",
      "agents.defaults.heartbeat.agentId",
      "agents.defaults.systemAgent.agentId",
      "talk.agentId",
    ]);
  });

  it("does not warn for sole-agent or explicitly owned multi-agent config", () => {
    for (const config of [
      { agents: { entries: { solo: {} } } },
      {
        agents: {
          defaults: {
            heartbeat: { agentId: "ops" },
            systemAgent: { agentId: "ops" },
          },
          entries: { ops: {}, research: {} },
        },
        channels: { telegram: { enabled: true } },
        bindings: [{ agentId: "ops", match: { channel: "telegram", accountId: "*" } }],
        talk: { agentId: "ops" },
      },
    ]) {
      const result = validateConfigObjectWithPlugins(config, { pluginValidation: "skip" });
      expect(result.ok).toBe(true);
      expect(result.warnings).toEqual([]);
    }
  });
});
