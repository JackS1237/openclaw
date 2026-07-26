import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { readCronStoreEpoch } from "./row-codec.js";

const execFileAsync = promisify(execFile);

const concurrentWriterSource = `
  const { DatabaseSync } = await import("node:sqlite");
  const { upsertCronJobRow } = await import("./src/cron/store/row-codec.ts");
  const database = new DatabaseSync(process.argv[1]);
  database.exec("PRAGMA busy_timeout = 5000");
  const now = Date.now();
  const epoch = upsertCronJobRow(database, "cron-epoch-test", {
    id: process.argv[2],
    name: process.argv[2],
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "hello" },
    state: {},
  }, 0);
  database.close();
  process.stdout.write(String(epoch));
`;

describe("cron store epoch", () => {
  it("assigns distinct epochs to concurrent row writes from independent processes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-epoch-"));
    const databasePath = path.join(root, "state.sqlite");
    openOpenClawStateDatabase({ path: databasePath });
    closeOpenClawStateDatabaseByPath(databasePath);
    const storeKey = "cron-epoch-test";
    try {
      const results = await Promise.all(
        ["first", "second"].map((jobId) =>
          execFileAsync(
            process.execPath,
            [
              "--import",
              "tsx",
              "--input-type=module",
              "-e",
              concurrentWriterSource,
              databasePath,
              jobId,
            ],
            { cwd: process.cwd() },
          ),
        ),
      );
      expect(results.map(({ stdout }) => Number(stdout)).toSorted((a, b) => a - b)).toEqual([1, 2]);

      const database = new DatabaseSync(databasePath);
      try {
        expect(readCronStoreEpoch(database, storeKey)).toBe(2);
      } finally {
        database.close();
      }
    } finally {
      closeOpenClawStateDatabaseByPath(databasePath);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
