import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";
import { spawnProcess } from "../spawn-utils.js";
import { BrokerChild } from "./child.js";

/** Publish cleanup ownership before waiting for the broker's pipe and IPC handoff. */
export function spawnServiceChildRelay(params: {
  entrypoint: Parameters<typeof resolveRuntimeWorkerUrl>[0];
  stdio: SpawnOptions["stdio"];
  useWindowsJobAnchor: boolean;
  onSpawnCleanup?: (completion: Promise<void>) => void;
}): {
  child: ChildProcess;
  extinctionCompletion: Deferred;
  transportReady: Promise<void> | undefined;
} {
  const workerUrl = resolveRuntimeWorkerUrl(params.entrypoint);
  const child = spawnProcess(process.execPath, resolveRuntimeWorkerArgv(workerUrl), {
    stdio: params.stdio,
    // A detached Windows Job owner survives host loss long enough to clean up.
    // Keep its child handle referenced so an idle host can finish admission and lineage cleanup.
    detached: params.useWindowsJobAnchor,
    windowsHide: true,
    env: process.env,
  });
  const extinctionCompletion = createDeferredCore();
  void extinctionCompletion.promise.catch(() => {});
  params.onSpawnCleanup?.(extinctionCompletion.promise);
  // Native pipes are ready synchronously; only the broker waits for transferred handles.
  const transportReady =
    child instanceof BrokerChild
      ? child.ready().catch((error: unknown) => {
          extinctionCompletion.reject(error);
          throw error;
        })
      : undefined;
  return { child, extinctionCompletion, transportReady };
}
