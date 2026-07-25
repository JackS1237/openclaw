import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { loadCronJobsStoreWithConfigJobsReadOnly, saveCronJobsStore } from "../../../cron/store.js";
import type { CronJob } from "../../../cron/types.js";
import { materializeLegacyDefaultCronJobOwners } from "./legacy-repair.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function legacyJob(id: string, sessionKey?: string): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    ...(sessionKey ? { sessionKey } : {}),
    payload: { kind: "agentTurn", message: id },
    delivery: { mode: "none" },
    state: {},
  };
}

describe("legacy default cron ownership", () => {
  it("persists the retired default only on ownerless jobs", async () => {
    const root = tempDirs.make("openclaw-cron-owner-");
    const storePath = path.join(root, "cron.sqlite");
    await saveCronJobsStore(storePath, {
      version: 1,
      jobs: [
        legacyJob("ownerless"),
        { ...legacyJob("explicit"), agentId: "research" },
        legacyJob("scoped", "agent:scoped:main"),
      ],
    });

    const first = await materializeLegacyDefaultCronJobOwners({
      cfg: { cron: { store: storePath } },
      legacyDefaultAgentId: "ops",
    });
    expect(first.changes).toHaveLength(1);
    const loaded = await loadCronJobsStoreWithConfigJobsReadOnly(storePath);
    expect(loaded.store.jobs.map((job) => [job.id, job.agentId])).toEqual([
      ["ownerless", "ops"],
      ["explicit", "research"],
      ["scoped", undefined],
    ]);

    await expect(
      materializeLegacyDefaultCronJobOwners({
        cfg: { cron: { store: storePath } },
        legacyDefaultAgentId: "ops",
      }),
    ).resolves.toMatchObject({ changes: [] });
  });
});
