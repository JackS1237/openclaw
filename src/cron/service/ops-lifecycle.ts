import { materializeLegacyDefaultCronJobOwners } from "../legacy-default-agent-owner-migration.js";
import { materializeLegacyDefaultCronJobOwnersInRecords } from "../legacy-default-agent-owner-records.js";
import { transformCronJobsStore } from "../store.js";
import type { CronJob } from "../types.js";
import { failureNotificationDeliveryFromJobState } from "./failure-alerts.js";
import { nextWakeAtMs, recomputeNextRunsForMaintenance } from "./jobs.js";
import { acquireCronOperationLock, locked } from "./locked.js";
import { emitCronRunFinished } from "./ops-run-preparation.js";
import { resolveCurrentDefaultAgentId } from "./ops-shared.js";
import { prepareReloadedCronJobsForScheduling } from "./reload-scheduling.js";
import { cancelCronRunAdmissionWaiters } from "./run-admission.js";
import {
  type InterruptedStartupRun,
  markInterruptedStartupRun,
  restoreFinalizedStartupRun,
  STARTUP_INTERRUPTED_ERROR,
} from "./startup-run-repair.js";
import type { CronServiceState } from "./state.js";
import { ensureLoaded, persist } from "./store.js";
import { tryFindCronTaskRunIdForRecovery, tryFindFinalizedCronTaskRun } from "./task-runs.js";
import { armTimer, runMissedJobs, stopTimer } from "./timer.js";

async function materializeLoadedLegacyDefaultAgentOwners(
  state: CronServiceState,
  legacyDefaultAgentId: string,
) {
  const jobs = state.store?.jobs ?? [];
  return await materializeLegacyDefaultCronJobOwners({
    storePath: state.deps.storePath,
    legacyDefaultAgentId,
    records: jobs as unknown as Array<Record<string, unknown>>,
    persistRecords: async (records) => {
      let candidateRecords = records;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let transformRan = false;
        let rewritten = 0;
        const expectedStoreEpoch = state.storeEpoch;
        await transformCronJobsStore(
          state.deps.storePath,
          (current) => {
            transformRan = true;
            const currentRecords = current.store.jobs as unknown as Array<Record<string, unknown>>;
            const currentIds = new Set(
              currentRecords.flatMap((record) =>
                typeof record.id === "string" ? [record.id] : [],
              ),
            );
            const missingRecords = candidateRecords.filter(
              (record) => typeof record.id === "string" && !currentIds.has(record.id),
            );
            const merged = [...currentRecords, ...missingRecords];
            rewritten = materializeLegacyDefaultCronJobOwnersInRecords(
              merged,
              legacyDefaultAgentId,
            );
            if (missingRecords.length === 0 && rewritten === 0) {
              return null;
            }
            return { version: 1, jobs: merged as unknown as CronJob[] };
          },
          { bumpStoreEpoch: true, expectedStoreEpoch },
        );
        if (transformRan) {
          return rewritten;
        }
        if (attempt === 1) {
          throw new Error("cron store changed during legacy owner migration twice; retry startup");
        }
        await ensureLoaded(state, { forceReload: true, skipRecompute: true });
        candidateRecords = (state.store?.jobs ?? []) as unknown as Array<Record<string, unknown>>;
      }
      return 0;
    },
  });
}

/** Locks mutations after materializing the loaded store until the topology commit settles. */
export async function beginLegacyDefaultAgentOwnerHandoff(
  state: CronServiceState,
  legacyDefaultAgentId: string,
) {
  const release = await acquireCronOperationLock(state);
  try {
    await ensureLoaded(state, { skipRecompute: true });
    const migration = await materializeLoadedLegacyDefaultAgentOwners(state, legacyDefaultAgentId);
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    return { migration, release };
  } catch (error) {
    release();
    throw error;
  }
}

/** Reloads one sealed service and schedules only jobs newly imported during the handoff. */
export async function refreshLegacyDefaultAgentOwnerHandoff(
  state: CronServiceState,
  options?: { persistSchedulingState?: boolean },
) {
  const previousJobIds = new Set(state.store?.jobs.map((job) => job.id) ?? []);
  await ensureLoaded(state, { forceReload: true, skipRecompute: true });
  const scheduledNewJob = prepareReloadedCronJobsForScheduling(state, { previousJobIds });
  if (scheduledNewJob && options?.persistSchedulingState !== false) {
    await persist(state, { stateOnly: true });
  }
  armTimer(state);
}

/** Replaces stale in-memory rows before a Gateway publishes new agent resolution. */
export async function reloadForConfigAdoption(state: CronServiceState) {
  const release = await acquireCronOperationLock(state);
  try {
    await ensureLoaded(state, { skipRecompute: true });
    const legacyDefaultAgentId = resolveCurrentDefaultAgentId(state);
    if (legacyDefaultAgentId) {
      const migration = await materializeLoadedLegacyDefaultAgentOwners(
        state,
        legacyDefaultAgentId,
      );
      if (migration.warnings.length > 0) {
        throw new Error(migration.warnings.join("\n"));
      }
    }
    await refreshLegacyDefaultAgentOwnerHandoff(state);
  } finally {
    release();
  }
}

/** Starts the cron service, recovers interrupted runs, catches up missed jobs, and arms the timer. */
export async function start(state: CronServiceState) {
  state.stopped = false;
  if (!state.deps.cronEnabled) {
    state.deps.log.info({ enabled: false }, "cron: disabled");
    return;
  }

  const interruptedJobIds = new Set<string>();
  const interruptedRuns: InterruptedStartupRun[] = [];
  const completedJobIdsToDelete = new Set<string>();
  let repairedAnyStartupRun = false;
  await locked(state, async () => {
    await ensureLoaded(state, { skipRecompute: true });
    if (state.deps.legacyDefaultAgentId) {
      const migration = await materializeLoadedLegacyDefaultAgentOwners(
        state,
        state.deps.legacyDefaultAgentId,
      );
      if (migration.warnings.length > 0) {
        throw new Error(migration.warnings.join("\n"));
      }
      for (const change of migration.changes) {
        state.deps.log.info({ storePath: state.deps.storePath }, `cron: ${change}`);
      }
      await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    }
    if (state.stopped) {
      return;
    }
    const jobs = state.store?.jobs ?? [];
    for (const job of jobs) {
      job.state ??= {};
      if (typeof job.state.queuedAtMs === "number") {
        state.deps.log.info(
          { jobId: job.id, queuedAtMs: job.state.queuedAtMs },
          "cron: releasing queued job reservation on startup",
        );
        job.state.queuedAtMs = undefined;
        repairedAnyStartupRun = true;
      }
      if (typeof job.state.runningAtMs === "number") {
        // Older releases used runningAtMs for both queued and active work. Those
        // rows are intentionally recovered conservatively to avoid replaying side effects.
        const runningAtMs = job.state.runningAtMs;
        const taskRunId = tryFindCronTaskRunIdForRecovery(state, job.id, runningAtMs);
        const finalized = tryFindFinalizedCronTaskRun(state, job.id, runningAtMs);
        if (finalized) {
          const repaired = restoreFinalizedStartupRun({
            state,
            job,
            runningAtMs,
            entry: finalized.entry,
            ...(finalized.scriptResult ? { scriptResult: finalized.scriptResult } : {}),
            ...(finalized.triggerEval ? { triggerEval: finalized.triggerEval } : {}),
          });
          // Skip only the old invocation; a distinct overdue replacement
          // must remain eligible for normal one-shot startup catch-up.
          if (repaired.replacementAtMs === undefined) {
            interruptedJobIds.add(job.id);
          }
          if (repaired.shouldDelete) {
            completedJobIdsToDelete.add(job.id);
          }
          repairedAnyStartupRun = true;
          continue;
        }
        const nowMs = state.deps.nowMs();
        const interrupted = markInterruptedStartupRun({
          state,
          job,
          taskRunId,
          runningAtMs,
          nowMs,
        });
        if (interrupted.replacementAtMs === undefined) {
          interruptedJobIds.add(job.id);
        }
        interruptedRuns.push(interrupted);
        repairedAnyStartupRun = true;
      }
    }
    if (completedJobIdsToDelete.size > 0 && state.store) {
      state.store.jobs = jobs.filter((job) => !completedJobIdsToDelete.has(job.id));
    }
    if (repairedAnyStartupRun || jobs.length > 0) {
      await persist(state, repairedAnyStartupRun ? undefined : { stateOnly: true });
    }
  });

  if (state.stopped) {
    return;
  }
  await runMissedJobs(state, {
    skipJobIds: interruptedJobIds.size > 0 ? interruptedJobIds : undefined,
    deferAgentTurnJobs: true,
  });

  await locked(state, async () => {
    // Startup catch-up already persisted the latest in-memory store state, and
    // this path runs before the scheduler begins servicing regular timer ticks.
    // Avoid an extra reload/write cycle on startup.
    await ensureLoaded(state, { skipRecompute: true });
    if (state.stopped) {
      return;
    }
    const changed = recomputeNextRunsForMaintenance(state, { recomputeExpired: true });
    if (changed) {
      await persist(state);
    }
    for (const interrupted of interruptedRuns) {
      const job = state.store?.jobs.find((entry) => entry.id === interrupted.jobId);
      emitCronRunFinished(
        state,
        {
          jobId: interrupted.jobId,
          action: "finished",
          job,
          status: "error",
          error: STARTUP_INTERRUPTED_ERROR,
          delivered: false,
          deliveryStatus: "unknown",
          deliveryError: STARTUP_INTERRUPTED_ERROR,
          failureNotificationDelivery: job
            ? failureNotificationDeliveryFromJobState(job)
            : undefined,
          runAtMs: interrupted.runAtMs,
          durationMs: interrupted.durationMs,
          nextRunAtMs: job?.state.nextRunAtMs,
        },
        undefined,
        interrupted.taskRunId,
      );
    }
    armTimer(state);
    state.deps.log.info(
      {
        enabled: true,
        jobs: state.store?.jobs.length ?? 0,
        nextWakeAtMs: nextWakeAtMs(state) ?? null,
      },
      "cron: started",
    );
  });
}

/** Stops the cron service timer without mutating persisted job state. */
export function stop(state: CronServiceState) {
  state.stopped = true;
  cancelCronRunAdmissionWaiters(state);
  state.schedulerStarted = false;
  stopTimer(state);
}

/** Temporarily stops automatic ticks without running startup recovery on resume. */
export function pauseScheduling(state: CronServiceState) {
  state.schedulingPaused = true;
  stopTimer(state);
}

export function resumeScheduling(state: CronServiceState) {
  if (!state.schedulingPaused) {
    return;
  }
  state.schedulingPaused = false;
  if (!state.schedulerStarted) {
    return;
  }
  try {
    armTimer(state);
  } catch (err) {
    // armTimer can install a timer before a later dependency throws. Roll the
    // whole transition back so a suspension retry cannot reopen without cron.
    state.schedulingPaused = true;
    stopTimer(state);
    throw err;
  }
}
