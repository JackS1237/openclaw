import path from "node:path";
import { normalizeAgentId } from "../routing/session-key.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { materializeLegacyDefaultCronJobOwnersInRecords } from "./legacy-default-agent-owner-records.js";
import { saveCronJobsStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { materializeCronRowAgentOwners } from "./store/row-codec.js";
import type { CronJob } from "./types.js";

export type LegacyDefaultCronOwnerMigrationResult = {
  changes: string[];
  warnings: string[];
};

/** Startup-owned idempotent SQLite migration for rows that relied on the retired marker. */
export async function materializeLegacyDefaultCronJobOwners(params: {
  storePath: string;
  legacyDefaultAgentId: string;
  records?: Array<Record<string, unknown>>;
  env?: NodeJS.ProcessEnv;
  persistRecords?: (records: Array<Record<string, unknown>>) => Promise<void>;
}): Promise<LegacyDefaultCronOwnerMigrationResult> {
  const agentId = normalizeAgentId(params.legacyDefaultAgentId);
  try {
    // Runtime reads only canonical cron_jobs rows. Doctor passes its merged
    // legacy-JSON records here explicitly before any later archival repair.
    const rewritten = params.records
      ? materializeLegacyDefaultCronJobOwnersInRecords(params.records, agentId)
      : runOpenClawStateWriteTransaction(
          ({ db }) =>
            materializeCronRowAgentOwners(
              db,
              cronStoreKey(path.resolve(params.storePath)),
              agentId,
            ),
          { env: params.env },
        );
    if (params.records && params.persistRecords) {
      await params.persistRecords(params.records);
    } else if (rewritten > 0 && params.records) {
      await saveCronJobsStore(
        params.storePath,
        {
          version: 1,
          jobs: params.records as unknown as CronJob[],
        },
        { env: params.env, bumpStoreEpoch: true },
      );
    }
    return rewritten > 0
      ? {
          changes: [
            `Assigned ${rewritten} legacy cron job${rewritten === 1 ? "" : "s"} to agent "${agentId}" before retiring the stored default.`,
          ],
          warnings: [],
        }
      : { changes: [], warnings: [] };
  } catch (error) {
    return {
      changes: [],
      warnings: [
        `Failed writing legacy cron owners at ${params.storePath}: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}
