import { describe, expect, it, vi } from "vitest";
import {
  beginLegacyDefaultOwnerHandoff,
  registerLiveCronService,
} from "./live-service-registry.js";
import { CronService } from "./service.js";

function createDeferred() {
  let resolve = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("live cron ownership handoff", () => {
  it("locks existing services and blocks later starters until release", async () => {
    const storePath = `/tmp/openclaw-live-cron-${Date.now()}.json`;
    const lockAcquired = createDeferred();
    const releaseServiceLock = vi.fn();
    const firstService = {
      beginLegacyDefaultAgentOwnerHandoff: vi.fn(async () => {
        await lockAcquired.promise;
        return {
          migration: { changes: ["locked"], warnings: [] },
          release: releaseServiceLock,
        };
      }),
      refreshLegacyDefaultAgentOwnerHandoff: vi.fn(async () => {}),
    };
    const firstRegistration = registerLiveCronService(storePath, firstService);
    await firstRegistration.ready;
    const handoff = beginLegacyDefaultOwnerHandoff({
      storePath,
      legacyDefaultAgentId: "ops",
    });
    let drained = false;
    const drain = handoff.drainAndSeal().then((result) => {
      drained = true;
      return result;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    const joiningService = {
      beginLegacyDefaultAgentOwnerHandoff: vi.fn(async () => ({
        migration: { changes: [], warnings: [] },
        release: vi.fn(),
      })),
      refreshLegacyDefaultAgentOwnerHandoff: vi.fn(async () => {}),
    };
    const joiningRegistration = registerLiveCronService(storePath, joiningService);
    let joiningReady = false;
    void joiningRegistration.ready.then(() => {
      joiningReady = true;
    });
    await Promise.resolve();
    expect(joiningReady).toBe(false);
    expect(joiningService.beginLegacyDefaultAgentOwnerHandoff).not.toHaveBeenCalled();

    lockAcquired.resolve();
    await expect(drain).resolves.toMatchObject({ changes: ["locked"], warnings: [] });
    expect(releaseServiceLock).not.toHaveBeenCalled();
    handoff.release();
    await expect(joiningRegistration.ready).resolves.toBeUndefined();
    expect(joiningReady).toBe(true);
    expect(releaseServiceLock).toHaveBeenCalledOnce();
    firstRegistration.unregister();
    joiningRegistration.unregister();
  });

  it("migrates once and refreshes a second live service sharing the store", async () => {
    const storePath = `/tmp/openclaw-live-cron-shared-${Date.now()}.json`;
    const releaseStoreLock = vi.fn();
    const leader = {
      beginLegacyDefaultAgentOwnerHandoff: vi.fn(async () => ({
        migration: { changes: ["migrated once"], warnings: [] },
        release: releaseStoreLock,
      })),
      refreshLegacyDefaultAgentOwnerHandoff: vi.fn(async () => {}),
    };
    const follower = {
      beginLegacyDefaultAgentOwnerHandoff: vi.fn(async () => {
        throw new Error("the follower must not acquire the shared store lock");
      }),
      refreshLegacyDefaultAgentOwnerHandoff: vi.fn(async () => {}),
    };
    const leaderRegistration = registerLiveCronService(storePath, leader);
    const followerRegistration = registerLiveCronService(storePath, follower);
    await Promise.all([leaderRegistration.ready, followerRegistration.ready]);

    const handoff = beginLegacyDefaultOwnerHandoff({
      storePath,
      legacyDefaultAgentId: "ops",
    });
    await expect(handoff.drainAndSeal()).resolves.toEqual({
      changes: ["migrated once"],
      warnings: [],
    });
    expect(leader.beginLegacyDefaultAgentOwnerHandoff).toHaveBeenCalledOnce();
    expect(follower.beginLegacyDefaultAgentOwnerHandoff).not.toHaveBeenCalled();
    expect(follower.refreshLegacyDefaultAgentOwnerHandoff).toHaveBeenCalledOnce();
    expect(releaseStoreLock).not.toHaveBeenCalled();

    await handoff.refreshSealedServices();
    expect(leader.refreshLegacyDefaultAgentOwnerHandoff).toHaveBeenCalledOnce();
    expect(follower.refreshLegacyDefaultAgentOwnerHandoff).toHaveBeenCalledTimes(2);

    handoff.release();
    expect(releaseStoreLock).toHaveBeenCalledOnce();
    leaderRegistration.unregister();
    followerRegistration.unregister();
  });

  it("does not start cron work after stop wins while registration is waiting", async () => {
    const storePath = `/tmp/openclaw-live-cron-cancel-${Date.now()}.json`;
    const handoff = beginLegacyDefaultOwnerHandoff({
      storePath,
      legacyDefaultAgentId: "ops",
    });
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const start = cron.start();
    await Promise.resolve();
    cron.stop();
    handoff.release();
    await start;
    expect(cron.getLoadedJobs()).toBeUndefined();
  });
});
