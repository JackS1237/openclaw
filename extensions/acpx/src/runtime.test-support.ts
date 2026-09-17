import path from "node:path";
import { vi } from "vitest";
import type { AcpRuntime, AcpRuntimeTurn } from "../runtime-api.js";
import { renderAgentCommand, type AcpxAgentCommand } from "./command-line.js";
import { OPENCLAW_ACPX_LEASE_ID_ARG, OPENCLAW_GATEWAY_INSTANCE_ID_ARG } from "./process-lease.js";
import { AcpxRuntime, type AcpSessionRecord, type AcpSessionStore } from "./runtime.js";
import { resolveAcpxSessionResource } from "./session-owner.js";
export type TestSessionStore = {
  load(sessionId: string): Promise<Record<string, unknown> | undefined>;
  save(record: Record<string, unknown>): Promise<void>;
};

export function makeEmptySessionStore(): TestSessionStore {
  return {
    load: vi.fn(async () => undefined),
    save: vi.fn(async () => {}),
  };
}

export const DOCUMENTED_OPENCLAW_BRIDGE_COMMAND =
  "env OPENCLAW_HIDE_BANNER=1 OPENCLAW_SUPPRESS_NOTES=1 openclaw acp --url ws://127.0.0.1:18789 --token-file ~/.openclaw/gateway.token --session agent:main:main";
export const CODEX_ACP_COMMAND = "npx @agentclientprotocol/codex-acp@1.10.0";
export const CODEX_ACP_WRAPPER_COMMAND = `node "/tmp/openclaw/acpx/codex-acp-wrapper.mjs"`;
export const CODEX_ACP_WRAPPER_COMMAND_WITH_LEASE = `${CODEX_ACP_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-close ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`;
export const LOCAL_NODE_MODULES_CODEX_COMMAND = `node "${path.resolve(
  "node_modules/@agentclientprotocol/codex-acp/dist/index.js",
)}"`;

export function makeTurn(
  input: { requestId: string },
  overrides: Partial<AcpRuntimeTurn> = {},
): AcpRuntimeTurn {
  return {
    requestId: input.requestId,
    promptStarted: Promise.resolve(),
    events: (async function* () {})(),
    result: Promise.resolve({ status: "completed" }),
    cancel: vi.fn(async () => {}),
    closeStream: vi.fn(async () => {}),
    ...overrides,
  };
}

export function runtimeCommand(runtime: AcpxRuntime): AcpxAgentCommand {
  const registry: { resolve(agent: string): AcpxAgentCommand } = Reflect.get(
    runtime,
    "scopedAgentRegistry",
  );
  return registry.resolve("codex");
}

export function recordCommand(command: AcpxAgentCommand) {
  return {
    agentCommand: renderAgentCommand(command),
    ...(typeof command === "string" ? {} : { agentArgv: command }),
  };
}

export function makeRuntime(
  baseStore: TestSessionStore,
  options: Partial<ConstructorParameters<typeof AcpxRuntime>[0]> = {},
  testOptions?: ConstructorParameters<typeof AcpxRuntime>[1],
): {
  runtime: AcpxRuntime;
  wrappedStore: TestSessionStore & {
    markFresh: (sessionKey: string) => void;
  };
  delegate: {
    cancel: AcpRuntime["cancel"];
    close: AcpRuntime["close"];
    ensureSession: AcpRuntime["ensureSession"];
    startTurn: NonNullable<AcpRuntime["startTurn"]>;
    getCapabilities: NonNullable<AcpRuntime["getCapabilities"]>;
    getStatus: NonNullable<AcpRuntime["getStatus"]>;
    setMode: NonNullable<AcpRuntime["setMode"]>;
    setConfigOption: NonNullable<AcpRuntime["setConfigOption"]>;
    isHealthy(): boolean;
    probeAvailability(): Promise<void>;
    doctor(): Promise<{ ok: boolean; message: string; details?: string[] }>;
  };
  bridgeSafeDelegate: {
    close: AcpRuntime["close"];
    ensureSession: AcpRuntime["ensureSession"];
    getStatus: NonNullable<AcpRuntime["getStatus"]>;
    setConfigOption: NonNullable<AcpRuntime["setConfigOption"]>;
    isHealthy(): boolean;
    probeAvailability(): Promise<void>;
    doctor(): Promise<{ ok: boolean; message: string; details?: string[] }>;
  };
} {
  const runtime = new AcpxRuntime(
    {
      cwd: "/tmp",
      sessionStore: baseStore as unknown as AcpSessionStore,
      agentRegistry: {
        resolve: (agentName: string) => (agentName === "openclaw" ? "openclaw acp" : agentName),
        list: () => ["codex", "openclaw"],
      },
      permissionMode: "approve-reads",
      ...options,
    },
    testOptions,
  );

  return {
    runtime,
    wrappedStore: (
      runtime as unknown as {
        sessionStore: TestSessionStore & {
          markFresh: (sessionKey: string) => void;
        };
      }
    ).sessionStore,
    delegate: (
      runtime as unknown as {
        delegate: {
          cancel: AcpRuntime["cancel"];
          close: AcpRuntime["close"];
          ensureSession: AcpRuntime["ensureSession"];
          startTurn: NonNullable<AcpRuntime["startTurn"]>;
          getCapabilities: NonNullable<AcpRuntime["getCapabilities"]>;
          getStatus: NonNullable<AcpRuntime["getStatus"]>;
          setMode: NonNullable<AcpRuntime["setMode"]>;
          setConfigOption: NonNullable<AcpRuntime["setConfigOption"]>;
          isHealthy(): boolean;
          probeAvailability(): Promise<void>;
          doctor(): Promise<{ ok: boolean; message: string; details?: string[] }>;
        };
      }
    ).delegate,
    bridgeSafeDelegate: (
      runtime as unknown as {
        bridgeSafeDelegate: {
          close: AcpRuntime["close"];
          ensureSession: AcpRuntime["ensureSession"];
          getStatus: NonNullable<AcpRuntime["getStatus"]>;
          setConfigOption: NonNullable<AcpRuntime["setConfigOption"]>;
          isHealthy(): boolean;
          probeAvailability(): Promise<void>;
          doctor(): Promise<{ ok: boolean; message: string; details?: string[] }>;
        };
      }
    ).bridgeSafeDelegate,
  };
}

export function makeManagedDelegateRuntime() {
  const target = { sessionKey: "shared-project", agentId: "main" };
  const resource = resolveAcpxSessionResource(target);
  const pid = process.pid + 1;
  let record: AcpSessionRecord = {
    schema: "acpx.session.v1",
    name: resource,
    acpxRecordId: resource,
    acpSessionId: "managed-delegate-session",
    agentCommand: CODEX_ACP_WRAPPER_COMMAND,
    cwd: "/tmp",
    pid,
    closed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    lastSeq: 0,
    messages: [],
    cumulative_token_usage: {},
    request_token_usage: {},
    eventLog: {
      active_path: "unused.jsonl",
      segment_count: 0,
      max_segment_bytes: 1024,
      max_segments: 1,
    },
  };
  const baseStore = {
    load: vi.fn(async () => structuredClone(record)),
    save: vi.fn(async (next: AcpSessionRecord) => {
      record = structuredClone(next);
    }),
  };
  const sleep = vi.fn(async () => {});
  const runtime = new AcpxRuntime(
    {
      cwd: "/tmp",
      sessionStore: baseStore,
      permissionMode: "deny-all",
      agentRegistry: { resolve: () => CODEX_ACP_WRAPPER_COMMAND, list: () => ["fixture"] },
      openclawToolsMcpBridgeEnabled: true,
      openclawWrapperRoot: "/tmp/openclaw/acpx",
      mcpServers: [{ name: "openclaw-tools", command: "node", args: [], env: [] }],
    },
    {
      openclawProcessCleanup: {
        platform: "linux",
        listProcesses: async () => [{ pid, ppid: 1, command: CODEX_ACP_WRAPPER_COMMAND }],
        killProcess: vi.fn(),
        sleep,
      },
    },
  );
  // Retention is observed directly; lifecycle operations use the real upstream runtime.
  const delegates = (
    runtime as unknown as {
      managedToolsSessionDelegates: ReadonlyMap<string, object>;
    }
  ).managedToolsSessionDelegates;
  return {
    runtime,
    target,
    resource,
    delegates,
    baseStore,
    sleep,
    ensure: () => runtime.ensureSession({ ...target, agent: "fixture", mode: "persistent" }),
  };
}

export function makeLeaseStore() {
  const leases = new Map<string, Record<string, unknown>>();
  return {
    leases,
    store: {
      load: vi.fn(async (leaseId: string) => leases.get(leaseId) as never),
      listOpen: vi.fn(async () => Array.from(leases.values()) as never),
      save: vi.fn(async (lease: Record<string, unknown>) => {
        leases.set(String(lease.leaseId), lease);
      }),
      markState: vi.fn(async (leaseId: string, state: string) => {
        if (state === "closed" || state === "lost") {
          leases.delete(leaseId);
          return;
        }
        const lease = leases.get(leaseId);
        if (lease) {
          lease.state = state;
        }
      }),
    },
  };
}

export function readFirstEnsureSessionInput(ensure: {
  mock: { calls: Array<Array<unknown>> };
}): Parameters<AcpRuntime["ensureSession"]>[0] {
  const [call] = ensure.mock.calls;
  if (!call) {
    throw new Error("Expected ensureSession to be called");
  }
  const [input] = call;
  if (typeof input !== "object" || input === null) {
    throw new Error("Expected ensureSession to be called with an input object");
  }
  return input as Parameters<AcpRuntime["ensureSession"]>[0];
}
