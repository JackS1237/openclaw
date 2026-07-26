import path from "node:path";
import type { LegacyDefaultCronOwnerMigrationResult } from "./legacy-default-agent-owner-migration.js";

type LiveCronOwnerMigration = {
  beginLegacyDefaultAgentOwnerHandoff: (legacyDefaultAgentId: string) => Promise<{
    migration: LegacyDefaultCronOwnerMigrationResult;
    release: () => void;
  }>;
};

type ActiveHandoff = {
  completion: Promise<void>;
  resolveCompletion: () => void;
  releases: Array<() => void>;
};

type LiveStoreState = {
  services: Set<LiveCronOwnerMigration>;
  handoff?: ActiveHandoff;
};

const liveStores = new Map<string, LiveStoreState>();

function getLiveStore(storePath: string): LiveStoreState {
  const key = path.resolve(storePath);
  const existing = liveStores.get(key);
  if (existing) {
    return existing;
  }
  const created = { services: new Set<LiveCronOwnerMigration>() };
  liveStores.set(key, created);
  return created;
}

/** Registers a starting CronService; handoff-time starters wait before loading. */
export function registerLiveCronService(
  storePath: string,
  service: LiveCronOwnerMigration,
): { ready: Promise<void>; unregister: () => void } {
  const key = path.resolve(storePath);
  const state = getLiveStore(key);
  state.services.add(service);
  return {
    ready: state.handoff?.completion ?? Promise.resolve(),
    unregister: () => {
      const current = liveStores.get(key);
      current?.services.delete(service);
      if (current && current.services.size === 0 && !current.handoff) {
        liveStores.delete(key);
      }
    },
  };
}

export type LiveCronOwnerHandoff = {
  drainAndSeal: () => Promise<LegacyDefaultCronOwnerMigrationResult>;
  release: () => void;
};

/** Locks every already-live service until the config commit settles. */
export function beginLegacyDefaultOwnerHandoff(params: {
  storePath: string;
  legacyDefaultAgentId: string;
}): LiveCronOwnerHandoff {
  const key = path.resolve(params.storePath);
  const state = getLiveStore(key);
  if (state.handoff) {
    throw new Error(`Cron ownership handoff already active for ${key}`);
  }
  let resolveCompletion = () => {};
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  const handoff: ActiveHandoff = { completion, resolveCompletion, releases: [] };
  state.handoff = handoff;
  // Registration is synchronous and every later starter waits on completion,
  // so this snapshot is the closed set of services already able to mutate jobs.
  const participants = [...state.services].map(async (service) => {
    const result = await service.beginLegacyDefaultAgentOwnerHandoff(params.legacyDefaultAgentId);
    handoff.releases.push(result.release);
    return result.migration;
  });
  let released = false;
  return {
    drainAndSeal: async () => {
      const results = await Promise.all(participants);
      return {
        changes: results.flatMap((result) => result.changes),
        warnings: results.flatMap((result) => result.warnings),
      };
    },
    release: () => {
      if (released) {
        return;
      }
      released = true;
      for (const release of handoff.releases.splice(0)) {
        release();
      }
      if (state.handoff === handoff) {
        delete state.handoff;
      }
      handoff.resolveCompletion();
      if (state.services.size === 0) {
        liveStores.delete(key);
      }
    },
  };
}
