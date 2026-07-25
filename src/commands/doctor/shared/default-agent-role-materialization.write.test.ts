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
      plugins?: { load?: { paths?: string[] } };
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

    const firstPersisted = await fs.readFile(configPath, "utf-8");
    const reread = await io.readConfigFileSnapshot();
    await io.writeConfigFile(reread.config, { baseSnapshot: reread });
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(firstPersisted);
  });

  it("persists a sole legacy cron owner before a roster write retires the marker", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-default-cron-owner-"));
    roots.push(root);
    const configPath = path.join(root, "openclaw.json");
    const stateDir = path.join(root, "state-root");
    const env = {
      HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TEST_FAST: "1",
    } as NodeJS.ProcessEnv;
    const storePath = resolveCronJobsStorePath(undefined, env);
    await fs.writeFile(
      configPath,
      `${JSON.stringify({
        agents: { entries: { ops: { default: true } } },
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

      await io.writeConfigFile(nextConfig, {
        baseSnapshot: snapshot,
        explicitSetPaths: [["agents", "entries"]],
        explicitSetValueSource: nextConfig,
      });

      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        agents?: { entries?: Record<string, { default?: boolean }> };
      };
      expect(persisted.agents?.entries?.ops).not.toHaveProperty("default");
      expect(
        (await loadCronJobsStoreWithConfigJobsReadOnly(storePath, env)).store.jobs[0]?.agentId,
      ).toBe("ops");
    });
  });
});
