/** Generation-bound persistence and process-lease metadata for ACPX resets. */
import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import type { AcpxRuntime as BaseAcpxRuntime, AcpRuntimeOptions } from "acpx/runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { AcpRuntime } from "../runtime-api.js";
import { renderAgentCommand, splitCommandParts, type AcpxAgentCommand } from "./command-line.js";
import {
  hashAcpxProcessCommand,
  readAcpxProcessLeaseIdentity,
  type AcpxProcessLease,
  type AcpxProcessLeaseIdentity,
  type AcpxProcessLeaseStore,
} from "./process-lease.js";
import { isOpenClawLeaseAwareAcpxProcessCommand } from "./process-reaper.js";
type OpenClawRuntimeHandle = Awaited<ReturnType<AcpRuntime["ensureSession"]>>;
export type AcpSessionStore = AcpRuntimeOptions["sessionStore"];
export type AcpSessionRecord = Parameters<AcpSessionStore["save"]>[0];
export type AcpLoadedSessionRecord = Awaited<ReturnType<AcpSessionStore["load"]>>;
export type ResetAwareSessionStore = AcpSessionStore & {
  markFresh: (sessionKey: string) => void;
  isFresh: (sessionKey: string) => boolean;
  loadForClose: (sessionKey: string) => Promise<AcpLoadedSessionRecord>;
};

type OpenClawLeaseSessionMetadata = {
  openclawLeaseId: string;
  openclawGatewayInstanceId: string;
};

function withOpenClawLeaseSessionMetadata<T extends object>(
  record: T,
  lease: AcpxProcessLeaseIdentity,
): T & OpenClawLeaseSessionMetadata {
  return {
    ...record,
    openclawLeaseId: lease.leaseId,
    openclawGatewayInstanceId: lease.gatewayInstanceId,
  };
}

export type AcpxLaunchLeaseContext = {
  leaseId: string;
  gatewayInstanceId: string;
  sessionKey: string;
  wrapperRoot: string;
  resolvedCommand: AcpxAgentCommand;
  leasedCommand: AcpxAgentCommand;
};

export type AcpxGeneration = {
  id: number;
  resource: string;
  ensureQueue: KeyedAsyncQueue;
  retired: boolean;
  afterReset: boolean;
  awaitPriorWrites: boolean;
  record?: AcpLoadedSessionRecord;
  delegate?: BaseAcpxRuntime;
};
export const acpxGenerationKey = Symbol("openclaw.acpxGeneration");
export type GenerationHandle = OpenClawRuntimeHandle & { [acpxGenerationKey]?: AcpxGeneration };
export const acpxOperationScope = new AsyncLocalStorage<{
  generation: AcpxGeneration;
  closeRecord?: AcpLoadedSessionRecord;
}>();

export function readSessionRecordName(record: unknown): string {
  if (typeof record !== "object" || record === null) {
    return "";
  }
  const { name } = record as { name?: unknown };
  return typeof name === "string" ? name.trim() : "";
}

export function readRecordAgentCommand(
  record: AcpLoadedSessionRecord,
): AcpxAgentCommand | undefined {
  return record?.agentArgv ?? record?.agentCommand;
}

export function readRecordCwd(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null) {
    return undefined;
  }
  const { cwd } = record as { cwd?: unknown };
  return typeof cwd === "string" ? cwd.trim() || undefined : undefined;
}

export function readRecordResetOnNextEnsure(record: unknown): boolean {
  if (typeof record !== "object" || record === null) {
    return false;
  }
  const { acpx } = record as { acpx?: unknown };
  if (typeof acpx !== "object" || acpx === null) {
    return false;
  }
  return (acpx as { reset_on_next_ensure?: unknown }).reset_on_next_ensure === true;
}

export function readRecordAgentPid(record: unknown): number | undefined {
  if (typeof record !== "object" || record === null) {
    return undefined;
  }
  const { pid, processId } = record as { pid?: unknown; processId?: unknown };
  const rawPid = pid ?? processId;
  const numericPid =
    typeof rawPid === "number"
      ? rawPid
      : typeof rawPid === "string"
        ? parseStrictPositiveInteger(rawPid)
        : undefined;
  return numericPid && Number.isInteger(numericPid) && numericPid > 0 ? numericPid : undefined;
}

export function readOpenClawLeaseIdFromRecord(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null) {
    return undefined;
  }
  const { openclawLeaseId } = record as { openclawLeaseId?: unknown };
  return typeof openclawLeaseId === "string" ? openclawLeaseId.trim() || undefined : undefined;
}

export function readOpenClawGatewayInstanceIdFromRecord(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null) {
    return undefined;
  }
  const { openclawGatewayInstanceId } = record as { openclawGatewayInstanceId?: unknown };
  return typeof openclawGatewayInstanceId === "string"
    ? openclawGatewayInstanceId.trim() || undefined
    : undefined;
}

export function extractGeneratedWrapperPath(command: AcpxAgentCommand | undefined): string {
  const parts = splitCommandParts(command ?? "");
  return (
    parts.find(
      (part) =>
        (part.split(/[\\/]/).pop() ?? "") === "codex-acp-wrapper.mjs" ||
        (part.split(/[\\/]/).pop() ?? "") === "claude-agent-acp-wrapper.mjs",
    ) ?? ""
  );
}

export function selectCurrentSessionLease(params: {
  leases: AcpxProcessLease[];
  sessionKeys: string[];
  rootPid?: number;
}): AcpxProcessLease | undefined {
  const sessionKeys = new Set(normalizeStringEntries(params.sessionKeys));
  const candidates = params.leases.filter((lease) => sessionKeys.has(lease.sessionKey));
  if (params.rootPid) {
    return candidates.find((lease) => lease.rootPid === params.rootPid);
  }
  let selected: AcpxProcessLease | undefined;
  for (const lease of candidates) {
    if (!selected || lease.startedAt > selected.startedAt) {
      selected = lease;
    }
  }
  return selected;
}

export function createResetAwareSessionStore(
  baseStore: AcpSessionStore,
  params?: {
    gatewayInstanceId?: string;
    leaseStore?: AcpxProcessLeaseStore;
    launchScope?: AsyncLocalStorage<AcpxLaunchLeaseContext | undefined>;
    wrapperRoot?: string;
  },
): ResetAwareSessionStore {
  const freshSessionKeys = new Set<string>();
  const stateQueue = new KeyedAsyncQueue();
  const pendingWrites = new Map<string, Set<Promise<void>>>();

  return {
    async load(sessionId: string): Promise<AcpLoadedSessionRecord> {
      const scope = acpxOperationScope.getStore();
      if (
        scope?.closeRecord &&
        (sessionId === scope.generation.resource || sessionId === scope.closeRecord.acpxRecordId)
      ) {
        return scope.closeRecord;
      }
      const resource = scope?.generation.resource ?? sessionId.trim();
      if (scope?.generation.awaitPriorWrites || freshSessionKeys.has(resource)) {
        await Promise.allSettled(pendingWrites.get(resource) ?? []);
      }
      const load = async () => {
        if (scope?.generation.retired) {
          return undefined;
        }
        const normalized = sessionId.trim();
        if (normalized && freshSessionKeys.has(normalized)) {
          return undefined;
        }
        const record = await baseStore.load(sessionId);
        if (
          scope?.generation.retired ||
          freshSessionKeys.has(scope?.generation.resource ?? normalized)
        ) {
          return undefined;
        }
        if (scope) {
          scope.generation.record = record;
        }
        if (!record || !params?.leaseStore || !params.gatewayInstanceId) {
          return record;
        }
        const sessionName = readSessionRecordName(record) || normalized;
        const lease = selectCurrentSessionLease({
          leases: await params.leaseStore.listOpen(params.gatewayInstanceId),
          sessionKeys: [sessionName, normalized],
          rootPid: readRecordAgentPid(record),
        });
        if (!lease) {
          return record;
        }
        if (scope?.generation.retired) {
          return undefined;
        }
        const leasedRecord = withOpenClawLeaseSessionMetadata(record, lease);
        if (scope) {
          scope.generation.record = leasedRecord;
        }
        return leasedRecord;
      };
      return await load();
    },
    async save(record: AcpSessionRecord): Promise<void> {
      const scope = acpxOperationScope.getStore();
      // Keep the exact old record available for cleanup even when publication is fenced.
      if (scope) {
        scope.generation.record = record;
      }
      const resource = scope?.generation.resource ?? readSessionRecordName(record);
      const writeRecord = async () => {
        if (scope?.generation.retired) {
          return;
        }
        let recordToSave = record;
        const launch = params?.launchScope?.getStore();
        const sessionName = readSessionRecordName(record);
        const agentCommand = readRecordAgentCommand(record);
        const leasedCommand = launch?.leasedCommand ?? agentCommand;
        const leaseIdentity = launch ?? readAcpxProcessLeaseIdentity(leasedCommand);
        if (
          params?.leaseStore &&
          params.gatewayInstanceId &&
          params.wrapperRoot &&
          (!launch || sessionName === launch.sessionKey) &&
          leasedCommand &&
          leaseIdentity?.gatewayInstanceId === params.gatewayInstanceId &&
          isOpenClawLeaseAwareAcpxProcessCommand({
            command: leasedCommand,
            wrapperRoot: params.wrapperRoot,
          })
        ) {
          const existing = await params.leaseStore.load(leaseIdentity.leaseId);
          if (scope?.generation.retired) {
            return;
          }
          const ownsExisting =
            !existing ||
            (existing.gatewayInstanceId === leaseIdentity.gatewayInstanceId &&
              existing.sessionKey === sessionName &&
              existing.wrapperRoot === params.wrapperRoot);
          if (ownsExisting) {
            const adoptingLease = Boolean(
              launch &&
              !isDeepStrictEqual(
                splitCommandParts(launch.resolvedCommand),
                splitCommandParts(launch.leasedCommand),
              ),
            );
            const persistedCommand =
              launch && !adoptingLease ? launch.resolvedCommand : leasedCommand;
            const lifecycleRecord = adoptingLease
              ? {
                  ...record,
                  // A reused legacy record can carry the previous wrapper PID. Clear
                  // it before persisting the new lease so reconnect cannot claim it.
                  pid: undefined,
                  processId: undefined,
                  agentStartedAt: undefined,
                }
              : record;
            const rootPid = readRecordAgentPid(lifecycleRecord);
            if (rootPid) {
              await params.leaseStore.save({
                leaseId: leaseIdentity.leaseId,
                gatewayInstanceId: leaseIdentity.gatewayInstanceId,
                sessionKey: sessionName,
                wrapperRoot: params.wrapperRoot,
                wrapperPath: extractGeneratedWrapperPath(leasedCommand),
                rootPid,
                ...(existing?.rootPid === rootPid && existing.processGroupId
                  ? { processGroupId: existing.processGroupId }
                  : {}),
                commandHash: hashAcpxProcessCommand(persistedCommand),
                startedAt: existing?.rootPid === rootPid ? existing.startedAt : Date.now(),
                state: "open",
              });
            }
            recordToSave = withOpenClawLeaseSessionMetadata(
              {
                ...lifecycleRecord,
                // ACPX reconnects from the persisted command, so lease identity must
                // remain in that reuse key until the session lifecycle is terminal.
                agentCommand: renderAgentCommand(persistedCommand),
                agentArgv: Array.isArray(persistedCommand) ? persistedCommand : undefined,
              },
              leaseIdentity,
            );
          }
        }
        if (scope?.generation.retired) {
          return;
        }
        await baseStore.save(recordToSave);
        if (scope && !scope.generation.retired) {
          scope.generation.awaitPriorWrites = false;
        }
        if (sessionName && !scope?.generation.retired) {
          freshSessionKeys.delete(sessionName);
        }
      };
      // Only a reset successor waits for conflicting physical writes. Ordinary
      // close overlap retains ACPX's existing non-blocking lifecycle semantics.
      const writes = pendingWrites.get(resource) ?? new Set<Promise<void>>();
      const previous = [...writes];
      const write = scope?.generation.awaitPriorWrites
        ? Promise.allSettled(previous).then(() => stateQueue.enqueue(resource, writeRecord))
        : writeRecord();
      writes.add(write);
      pendingWrites.set(resource, writes);
      try {
        await write;
      } finally {
        writes.delete(write);
        if (writes.size === 0 && pendingWrites.get(resource) === writes) {
          pendingWrites.delete(resource);
        }
      }
    },
    // Snapshot cleanup without joining a blocked writer or consulting fresh-name markers.
    loadForClose: (sessionKey) => baseStore.load(sessionKey),
    isFresh: (sessionKey) => freshSessionKeys.has(sessionKey),
    markFresh(sessionKey: string): void {
      const normalized = sessionKey.trim();
      if (normalized) {
        freshSessionKeys.add(normalized);
      }
    },
  };
}
