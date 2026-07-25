import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfigIO, resetConfigRuntimeState } from "../../../config/io.js";
import {
  loadCronJobsStoreWithConfigJobsReadOnly,
  resolveCronJobsStorePath,
  saveCronJobsStore,
} from "../../../cron/store.js";
import type { CronJob } from "../../../cron/types.js";
import { withEnvAsync } from "../../../test-utils/env.js";

const roots: string[] = [];

afterEach(async () => {
  resetConfigRuntimeState();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("default role materialization authored writes", () => {
  it("preserves env references and includes and is idempotent after persistence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-default-roles-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    const channelsPath = path.join(root, "channels.json5");
    const includeRaw = `${JSON.stringify({ telegram: { enabled: true } }, null, 2)}\n`;
    await fs.writeFile(channelsPath, includeRaw, "utf-8");
    const workspacePluginPath = path.join(
      root,
      ".openclaw",
      "workspace",
      ".openclaw",
      "extensions",
    );
    await fs.mkdir(workspacePluginPath, { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          agents: {
            defaults: { model: "${DEFAULT_MODEL}" },
            entries: {
              ops: { default: true },
              research: { model: "${RESEARCH_MODEL}" },
            },
          },
          channels: { $include: "./channels.json5" },
          plugins: {
            entries: {
              "voice-call": {
                enabled: true,
                config: { enabled: true, provider: "mock" },
              },
            },
          },
          talk: { provider: "test" },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const io = createConfigIO({
      configPath,
      env: {
        HOME: root,
        OPENCLAW_TEST_FAST: "1",
        DEFAULT_MODEL: "openai/default-model",
        RESEARCH_MODEL: "openai/research-model",
      } as NodeJS.ProcessEnv,
      homedir: () => root,
      observe: false,
      logger: { warn: () => {}, error: () => {} },
    });

    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.config.agents?.entries?.ops).not.toHaveProperty("default");
    expect(snapshot.config.agents?.defaults?.heartbeat?.agentId).toBe("ops");
    await io.writeConfigFile(snapshot.config, {
      baseSnapshot: snapshot,
      explicitSetPaths: [["agents", "entries"]],
      explicitSetValueSource: snapshot.config,
    });

    const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
      agents?: {
        defaults?: { model?: string; heartbeat?: { agentId?: string } };
        entries?: Record<string, { model?: string; default?: boolean; workspace?: string }>;
      };
      channels?: { $include?: string };
      bindings?: Array<{ agentId?: string; match?: { channel?: string; accountId?: string } }>;
      talk?: { agentId?: string };
      plugins?: {
        load?: { paths?: string[] };
        entries?: Record<string, { config?: Record<string, unknown> }>;
      };
    };
    expect(persisted.agents?.defaults?.model).toBe("${DEFAULT_MODEL}");
    expect(persisted.agents?.entries?.research?.model).toBe("${RESEARCH_MODEL}");
    expect(persisted.agents?.entries?.ops).not.toHaveProperty("default");
    expect(persisted.agents?.entries?.ops?.workspace).toBe(
      path.join(root, ".openclaw", "workspace"),
    );
    expect(persisted.channels).toEqual({ $include: "./channels.json5" });
    await expect(fs.readFile(channelsPath, "utf-8")).resolves.toBe(includeRaw);
    expect(persisted.bindings).toContainEqual({
      agentId: "ops",
      match: { channel: "telegram", accountId: "*" },
    });
    expect(persisted.agents?.defaults?.heartbeat?.agentId).toBe("ops");
    expect(persisted.talk?.agentId).toBe("ops");
    expect(persisted.plugins?.load?.paths).toContain(workspacePluginPath);
    expect(persisted.plugins?.entries?.["voice-call"]?.config?.agentId).toBe("ops");

    const firstPersisted = await fs.readFile(configPath, "utf-8");
    const reread = await io.readConfigFileSnapshot();
    await io.writeConfigFile(reread.config, { baseSnapshot: reread });
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(firstPersisted);
  });

  it.each([
    { label: "marked", entry: { default: true } },
    { label: "markerless", entry: {} },
  ])(
    "persists a $label sole cron owner before a roster write creates a fleet",
    async ({ entry }) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-default-cron-owner-"));
      roots.push(root);
      const configPath = path.join(root, "openclaw.json");
      const stateDir = path.join(root, "state-root");
      const env = {
        HOME: root,
        DISCORD_BOT_TOKEN: "env-only-token",
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_TEST_FAST: "1",
      } as NodeJS.ProcessEnv;
      const storePath = resolveCronJobsStorePath(undefined, env);
      const soleWorkspace = path.join(root, ".openclaw", "workspace");
      const workspacePluginPath = path.join(soleWorkspace, ".openclaw", "extensions");
      await fs.mkdir(workspacePluginPath, { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify({
          agents: { entries: { ops: entry } },
          plugins: {
            entries: {
              "voice-call": {
                enabled: true,
                config: { enabled: true, provider: "mock" },
              },
            },
          },
        })}\n`,
        "utf-8",
      );
      const ownerlessJob: CronJob = {
        id: "ownerless",
        name: "ownerless",
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "run" },
        state: {},
      };

      await withEnvAsync(env, async () => {
        await saveCronJobsStore(storePath, { version: 1, jobs: [ownerlessJob] });
        const io = createConfigIO({
          configPath,
          env,
          homedir: () => root,
          observe: false,
          logger: { warn: () => {}, error: () => {} },
        });
        const snapshot = await io.readConfigFileSnapshot();
        const nextConfig = {
          ...snapshot.config,
          agents: {
            ...snapshot.config.agents,
            entries: { ...snapshot.config.agents?.entries, research: {} },
          },
        };
        const explicitSetValueSource = {
          ...nextConfig,
          agents: {
            ...nextConfig.agents,
            defaults: {
              ...nextConfig.agents.defaults,
              model: { primary: "openai/gpt-5.5" },
            },
          },
        };

        await io.writeConfigFile(nextConfig, {
          baseSnapshot: snapshot,
          explicitSetPaths: [["agents"]],
          explicitSetValueSource,
        });

        const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
          agents?: {
            defaults?: {
              heartbeat?: { agentId?: string };
              model?: { primary?: string };
              systemAgent?: { agentId?: string };
            };
            entries?: Record<string, { default?: boolean; workspace?: string }>;
          };
          bindings?: Array<{ agentId?: string; match?: { channel?: string; accountId?: string } }>;
          plugins?: {
            load?: { paths?: string[] };
            entries?: Record<string, { config?: Record<string, unknown> }>;
          };
          talk?: { agentId?: string };
        };
        expect(persisted.agents?.entries?.ops).not.toHaveProperty("default");
        expect(persisted.agents?.entries?.ops?.workspace).toBe(soleWorkspace);
        expect(persisted.plugins?.load?.paths).toContain(workspacePluginPath);
        expect(persisted.bindings).toContainEqual({
          agentId: "ops",
          match: { channel: "discord", accountId: "*" },
        });
        expect(persisted.agents?.defaults?.heartbeat?.agentId).toBe("ops");
        expect(persisted.agents?.defaults?.systemAgent?.agentId).toBe("ops");
        expect(persisted.talk?.agentId).toBe("ops");
        expect(persisted.plugins?.entries?.["voice-call"]?.config?.agentId).toBe("ops");
        expect(persisted.agents?.defaults?.model?.primary).toBe("openai/gpt-5.5");
        expect(
          (await loadCronJobsStoreWithConfigJobsReadOnly(storePath, env)).store.jobs[0]?.agentId,
        ).toBe("ops");
      });
    },
  );

  it("persists per-surface first-entry ownership and clears migration warnings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-marker-free-roles-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    const raw = {
      agents: { entries: { ops: {}, research: {} } },
      channels: { telegram: { enabled: true } },
      bindings: [{ agentId: "research", match: { channel: "telegram", accountId: "work" } }],
    };
    await fs.writeFile(configPath, `${JSON.stringify(raw)}\n`, "utf-8");
    const io = createConfigIO({
      configPath,
      env: { HOME: root, OPENCLAW_TEST_FAST: "1" } as NodeJS.ProcessEnv,
      homedir: () => root,
      observe: false,
      logger: { warn: () => {}, error: () => {} },
    });

    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.warnings.map((warning) => warning.path)).toEqual(
      expect.arrayContaining([
        "agents.entries.ops.workspace",
        "channels.telegram",
        "agents.defaults.heartbeat.agentId",
        "agents.defaults.systemAgent.agentId",
        "talk.agentId",
      ]),
    );
    await io.writeConfigFile(snapshot.config, {
      baseSnapshot: snapshot,
      explicitSetPaths: [["agents", "entries"]],
      explicitSetValueSource: snapshot.config,
    });

    resetConfigRuntimeState();
    const reread = await io.readConfigFileSnapshot();
    expect(reread.warnings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("marker-free fleet") }),
      ]),
    );
    expect(reread.config.bindings).toContainEqual({
      agentId: "ops",
      match: { channel: "telegram", accountId: "*" },
    });
    expect(reread.config.agents?.entries?.ops?.workspace).toBe(
      path.join(root, ".openclaw", "workspace"),
    );
  });

  it("does not hand ownership to a previous sole agent removed by the fleet write", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-replaced-sole-owner-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    const env = {
      HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state-root"),
      OPENCLAW_TEST_FAST: "1",
    } as NodeJS.ProcessEnv;
    const storePath = resolveCronJobsStorePath(undefined, env);
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ agents: { entries: { ops: {} } } })}\n`,
      "utf-8",
    );
    const ownerlessJob: CronJob = {
      id: "ownerless-replacement",
      name: "ownerless replacement",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "run" },
      state: {},
    };

    await withEnvAsync(env, async () => {
      await saveCronJobsStore(storePath, { version: 1, jobs: [ownerlessJob] });
      const io = createConfigIO({
        configPath,
        env,
        homedir: () => root,
        observe: false,
        logger: { warn: () => {}, error: () => {} },
      });
      const snapshot = await io.readConfigFileSnapshot();
      const nextConfig = {
        ...snapshot.config,
        agents: {
          defaults: {
            ...snapshot.config.agents?.defaults,
            heartbeat: { agentId: "research" },
            systemAgent: { agentId: "research" },
          },
          entries: { research: {}, writer: {} },
        },
        bindings: [{ agentId: "research", match: { channel: "discord", accountId: "*" } }],
        talk: { ...snapshot.config.talk, agentId: "research" },
      };

      await io.writeConfigFile(nextConfig, {
        baseSnapshot: snapshot,
        explicitSetPaths: [["agents", "entries"]],
        explicitSetValueSource: nextConfig,
      });

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        agents?: { entries?: Record<string, unknown> };
      };
      expect(persisted.agents?.entries).toEqual({ research: {}, writer: {} });
      expect(
        (await loadCronJobsStoreWithConfigJobsReadOnly(storePath, env)).store.jobs[0]?.agentId,
      ).toBeUndefined();
    });
  });
});
