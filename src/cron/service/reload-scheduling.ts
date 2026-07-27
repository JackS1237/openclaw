import { computeJobNextRunAtMs, hasScheduledNextRunAtMs, isJobEnabled } from "./jobs.js";
import type { CronServiceState } from "./state.js";

/** Prepares enabled rows discovered by a store reload before the timer is armed. */
export function prepareReloadedCronJobsForScheduling(
  state: CronServiceState,
  options: { previousJobIds?: ReadonlySet<string> } = {},
): boolean {
  let scheduledJob = false;
  for (const job of state.store?.jobs ?? []) {
    if (
      options.previousJobIds?.has(job.id) ||
      !isJobEnabled(job) ||
      hasScheduledNextRunAtMs(job.state.nextRunAtMs)
    ) {
      continue;
    }
    job.state.nextRunAtMs = computeJobNextRunAtMs(job, state.deps.nowMs());
    scheduledJob = true;
  }
  return scheduledJob;
}
