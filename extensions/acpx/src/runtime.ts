/**
 * OpenClaw ACPX runtime adapter. It wraps the upstream acpx runtime with
 * OpenClaw session metadata, lease tracking, model scoping, and cleanup policy.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path, { resolve as resolvePath } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  ACPX_BACKEND_ID,
  AcpxRuntime as BaseAcpxRuntime,
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  decodeAcpxRuntimeHandleState,
  encodeAcpxRuntimeHandleState,
  isRequestedModelUnsupportedError,
  type AcpAgentRegistry,
  type AcpRuntimeDoctorReport,
  type AcpRuntimeEvent,
  type AcpRuntimeOptions,
  type AcpRuntimeStatus,
  type AcpRuntimeTurnResult,
  type SessionAgentOptions,
} from "acpx/runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { AcpRuntimeError, type AcpRuntime, type AcpRuntimeErrorCode } from "../runtime-api.js";
import { CODEX_ACP_PACKAGE, OPENCLAW_CODEX_CONFIG_ARG } from "./codex-adapter.js";
import { renderAgentCommand, splitCommandParts, type AcpxAgentCommand } from "./command-line.js";
import {
  ACPX_PROBE_LEASE_SESSION_KEY,
  hashAcpxProcessCommand,
  readAcpxProcessLeaseIdentity,
  withAcpxLeaseArgs,
  type AcpxProcessLeaseIdentity,
  type AcpxProcessLeaseStore,
} from "./process-lease.js";
import {
  cleanupOpenClawOwnedAcpxPendingLease,
  cleanupOpenClawOwnedAcpxProcessTree,
  isOpenClawLeaseAwareAcpxProcessCommand,
  type AcpxProcessCleanupDeps,
} from "./process-reaper.js";
import type { CompleteAcpRuntime, CompleteAcpRuntimeTurn } from "./runtime-proxy.js";
import {
  type AcpSessionStore,
  type AcpSessionRecord,
  type AcpLoadedSessionRecord,
  type ResetAwareSessionStore,
  type AcpxLaunchLeaseContext,
  type AcpxGeneration,
  acpxGenerationKey,
  type GenerationHandle,
  acpxOperationScope,
  readSessionRecordName,
  readRecordAgentCommand,
  readRecordCwd,
  readRecordResetOnNextEnsure,
  readRecordAgentPid,
  readOpenClawLeaseIdFromRecord,
  readOpenClawGatewayInstanceIdFromRecord,
  extractGeneratedWrapperPath,
  selectCurrentSessionLease,
  createResetAwareSessionStore,
} from "./runtime-session-store.js";
import {
  assertAcpxSessionOwnerLocator,
  resolveAcpxSessionResource,
  toAcpxResourceInput,
} from "./session-owner.js";

type BaseAcpxRuntimeTestOptions = ConstructorParameters<typeof BaseAcpxRuntime>[1];
type OpenClawAcpxRuntimeOptions = AcpRuntimeOptions & {
  openclawLegacyBareSessionKeys?: ReadonlySet<string>;
  openclawWrapperRoot?: string;
  openclawGatewayInstanceId?: string;
  openclawProcessLeaseStore?: AcpxProcessLeaseStore;
  pluginToolsMcpBridgeEnabled?: boolean;
  openclawToolsMcpBridgeEnabled?: boolean;
};
type AcpxRuntimeTestOptions = Record<string, unknown> & {
  openclawProcessCleanup?: AcpxProcessCleanupDeps;
};
type OpenClawRuntimeTurnInput = Parameters<NonNullable<AcpRuntime["startTurn"]>>[0];
type OpenClawRuntimeEnsureInput = Parameters<AcpRuntime["ensureSession"]>[0];
type OpenClawRuntimeHandle = Awaited<ReturnType<AcpRuntime["ensureSession"]>>;
type AcpxDelegateEnsureInput = Parameters<BaseAcpxRuntime["ensureSession"]>[0];
type AcpxMcpServer = NonNullable<AcpRuntimeOptions["mcpServers"]>[number];

const ACPX_PLUGIN_TOOLS_MCP_SERVER_NAME = "openclaw-plugin-tools";
const ACPX_OPENCLAW_TOOLS_MCP_SERVER_NAME = "openclaw-tools";
const OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV = "OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY";
type AcpxHandleOperationSnapshot = Readonly<{
  generation: AcpxGeneration;
  record: AcpLoadedSessionRecord;
  command: AcpxAgentCommand | undefined;
}>;

const CODEX_WRAPPER_STDERR_LOG_PREFIX = "codex-acp-wrapper.stderr";
const CODEX_WRAPPER_ERROR_TAIL_MAX_CHARS = 6_000;

function safeDiagnosticFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

function codexWrapperStderrLogFileName(leaseId: string): string {
  return `${CODEX_WRAPPER_STDERR_LOG_PREFIX}.${safeDiagnosticFilePart(leaseId)}.log`;
}

function compactDiagnosticText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isGenericInternalAcpErrorMessage(message: string): boolean {
  return message.trim() === "Internal error";
}

function isGenericInternalAcpError(error: unknown): error is Error {
  return error instanceof Error && isGenericInternalAcpErrorMessage(error.message);
}

async function readCodexWrapperStderrTail(params: {
  wrapperRoot: string | undefined;
  leaseId: string | undefined;
}): Promise<string> {
  if (!params.wrapperRoot || !params.leaseId) {
    return "";
  }
  try {
    const text = await fs.readFile(
      path.join(params.wrapperRoot, codexWrapperStderrLogFileName(params.leaseId)),
      "utf8",
    );
    return compactDiagnosticText(
      redactSensitiveText(sliceUtf16Safe(text, -CODEX_WRAPPER_ERROR_TAIL_MAX_CHARS)),
    );
  } catch {
    return "";
  }
}

const OPENCLAW_BRIDGE_EXECUTABLE = "openclaw";
const OPENCLAW_BRIDGE_SUBCOMMAND = "acp";
const CODEX_ACP_AGENT_ID = "codex";
const CODEX_ACP_OPENCLAW_PREFIX = "openai/";
// Documented OpenClaw provider prefixes the Claude Agent SDK does not understand.
// Strip only these; a generic first-slash split would corrupt native Bedrock
// inference-profile ids and ARNs the SDK accepts as-is.
const CLAUDE_ACP_OPENCLAW_PREFIX = /^(?:anthropic|amazon-bedrock)\//i;
const CODEX_ACP_THINKING_ALIASES = new Map<string, string | undefined>([
  ["off", undefined],
  ["minimal", "low"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["x-high", "xhigh"],
  ["x_high", "xhigh"],
  ["extra-high", "xhigh"],
  ["extra_high", "xhigh"],
  ["extra high", "xhigh"],
  ["xhigh", "xhigh"],
]);

type CodexAcpModelOverride = {
  model?: string;
  reasoningEffort?: string;
};

type CodexAcpModelClassification =
  | { kind: "override"; override: CodexAcpModelOverride }
  | { kind: "unsupported"; thinkingOverride?: CodexAcpModelOverride };

function normalizeAgentName(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function readAgentFromSessionKey(sessionKey: string | undefined): string | undefined {
  const normalized = sessionKey?.trim();
  if (!normalized) {
    return undefined;
  }
  const match = /^agent:(?<agent>[^:]+):/i.exec(normalized);
  return normalizeAgentName(match?.groups?.agent);
}

function readAgentFromHandle(handle: OpenClawRuntimeHandle): string | undefined {
  const decoded = decodeAcpxRuntimeHandleState(handle.runtimeSessionName);
  return normalizeAgentName(decoded?.agent) ?? readAgentFromSessionKey(handle.sessionKey);
}

function basename(value: string): string {
  return value.split(/[\\/]/).pop() ?? value;
}

function isEnvAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function unwrapEnvCommand(parts: string[]): string[] {
  const command = parts.at(0);
  if (!command || basename(command) !== "env") {
    return parts;
  }
  let index = 1;
  while (true) {
    const part = parts.at(index);
    if (!part || !isEnvAssignment(part)) {
      break;
    }
    index += 1;
  }
  return parts.slice(index);
}

function matchesExecutableName(value: string, executableName: string): boolean {
  const normalized = basename(value).toLowerCase();
  return normalized === executableName || normalized === `${executableName}.exe`;
}

function matchesPackageSpec(value: string, packageName: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === packageName || normalized.startsWith(`${packageName}@`);
}

function stripModuleExtension(value: string): string {
  return value.replace(/\.[cm]?js$/i, "").toLowerCase();
}

function isAcpCommand(
  command: AcpxAgentCommand | undefined,
  params: { packageName: string; executableName: string },
): boolean {
  if (!command) {
    return false;
  }
  const parts = unwrapEnvCommand(splitCommandParts(command));
  if (!parts.length) {
    return false;
  }
  if (parts.some((part) => matchesPackageSpec(part, params.packageName))) {
    return true;
  }
  const commandName = basename(parts[0] ?? "");
  if (matchesExecutableName(commandName, params.executableName)) {
    return true;
  }
  if (!matchesExecutableName(commandName, "node")) {
    return false;
  }
  const scriptName = stripModuleExtension(basename(parts[1] ?? ""));
  return scriptName === params.executableName || scriptName === `${params.executableName}-wrapper`;
}

function isOpenClawBridgeCommand(command: AcpxAgentCommand | undefined): boolean {
  if (!command) {
    return false;
  }
  const parts = unwrapEnvCommand(splitCommandParts(command));
  if (basename(parts[0] ?? "") === OPENCLAW_BRIDGE_EXECUTABLE) {
    return parts[1] === OPENCLAW_BRIDGE_SUBCOMMAND;
  }
  if (basename(parts[0] ?? "") !== "node") {
    return false;
  }
  const scriptName = basename(parts[1] ?? "");
  return /^openclaw(?:\.[cm]?js)?$/i.test(scriptName) && parts[2] === OPENCLAW_BRIDGE_SUBCOMMAND;
}

function isCodexAcpCommand(command: AcpxAgentCommand | undefined): boolean {
  return isAcpCommand(command, {
    packageName: CODEX_ACP_PACKAGE,
    executableName: "codex-acp",
  });
}

function isClaudeAcpCommand(command: AcpxAgentCommand | undefined): boolean {
  return isAcpCommand(command, {
    packageName: "@agentclientprotocol/claude-agent-acp",
    executableName: "claude-agent-acp",
  });
}

function failUnsupportedCodexAcpModel(rawModel: string): never {
  throw new AcpRuntimeError(
    "ACP_INVALID_RUNTIME_OPTION",
    `Codex ACP model "${rawModel}" is not supported. Use openai/<model> or <model>/<reasoning-effort>.`,
  );
}

const WIRE_TIMEOUT_CONFIG_KEYS = new Set(["timeout", "timeout_seconds"]);

// The handle codec coerces unknown modes to persistent; reject them before encoding.
function assertSupportedRuntimeSessionMode(
  mode: unknown,
): asserts mode is "persistent" | "oneshot" {
  if (mode === "persistent" || mode === "oneshot") {
    return;
  }
  throw new AcpRuntimeError(
    "ACP_INVALID_RUNTIME_OPTION",
    `Unsupported ACP runtime session mode ${JSON.stringify(mode)}. Expected one of: persistent, oneshot.`,
  );
}

function failUnsupportedCodexAcpThinking(rawThinking: string): never {
  throw new AcpRuntimeError(
    "ACP_INVALID_RUNTIME_OPTION",
    `Codex ACP thinking level "${rawThinking}" is not supported. Use off, minimal, low, medium, high, or xhigh.`,
  );
}

function normalizeCodexAcpReasoningEffort(rawThinking: string | undefined): string | undefined {
  const normalized = rawThinking?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (!CODEX_ACP_THINKING_ALIASES.has(normalized)) {
    failUnsupportedCodexAcpThinking(rawThinking ?? "");
  }
  return CODEX_ACP_THINKING_ALIASES.get(normalized);
}

function isCodexAcpReasoningEffortAlias(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return Boolean(normalized && CODEX_ACP_THINKING_ALIASES.has(normalized));
}

function classifyCodexAcpModelRequest(
  rawModel: string | undefined,
  rawThinking?: string,
): CodexAcpModelClassification {
  const raw = rawModel?.trim();
  const thinkingReasoningEffort = normalizeCodexAcpReasoningEffort(rawThinking);
  const thinkingOnlyOverride = thinkingReasoningEffort
    ? { reasoningEffort: thinkingReasoningEffort }
    : undefined;
  if (!raw) {
    return { kind: "override", override: thinkingOnlyOverride ?? {} };
  }

  let value = raw;
  let hadOpenAiQualifier = false;
  if (value.toLowerCase().startsWith(CODEX_ACP_OPENCLAW_PREFIX)) {
    value = value.slice(CODEX_ACP_OPENCLAW_PREFIX.length);
    hadOpenAiQualifier = true;
  }

  let model = value.trim();
  let modelReasoningEffort: string | undefined;
  const slashIndex = value.lastIndexOf("/");
  if (slashIndex >= 0 && isCodexAcpReasoningEffortAlias(value.slice(slashIndex + 1))) {
    modelReasoningEffort = normalizeCodexAcpReasoningEffort(value.slice(slashIndex + 1));
    model = value.slice(0, slashIndex).trim();
  }

  if (hadOpenAiQualifier && (!model || model.includes("/"))) {
    failUnsupportedCodexAcpModel(raw);
  }
  if (!model || model.includes("/")) {
    return thinkingOnlyOverride
      ? { kind: "unsupported", thinkingOverride: thinkingOnlyOverride }
      : { kind: "unsupported" };
  }

  // Explicit `off` omits the override even when the model carries an effort suffix.
  const reasoningEffort = rawThinking?.trim() ? thinkingReasoningEffort : modelReasoningEffort;
  return {
    kind: "override",
    override: {
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    },
  };
}

function withCodexSessionModel<T extends { model?: string }>(
  input: T,
  override: CodexAcpModelOverride | undefined,
): T {
  const next = { ...input };
  if (override?.model) {
    next.model = override.model;
  } else {
    delete next.model;
  }
  return next;
}

function normalizeClaudeAcpModelOverride(rawModel: string | undefined): string | undefined {
  const raw = rawModel?.trim();
  if (!raw) {
    return undefined;
  }
  const prefix = raw.match(CLAUDE_ACP_OPENCLAW_PREFIX);
  if (!prefix) {
    return raw;
  }
  return raw.slice(prefix[0].length).trim() || undefined;
}

function withAcpxSessionOptions(input: OpenClawRuntimeEnsureInput): AcpxDelegateEnsureInput {
  const existingOptions = (input as { sessionOptions?: SessionAgentOptions }).sessionOptions;
  const model = input.model?.trim() || existingOptions?.model;
  const sessionOptions = model ? { ...existingOptions, model } : existingOptions;
  const { modelExplicit: _modelExplicit, thinkingExplicit: _thinkingExplicit, ...rest } = input;
  return {
    ...rest,
    ...(sessionOptions ? { sessionOptions } : {}),
  } as AcpxDelegateEnsureInput;
}

function isAcpModelCapabilityMissingError(error: unknown): boolean {
  return isRequestedModelUnsupportedError(error) && error.reason === "missing-capability";
}

// Only inherited defaults may be dropped when a harness has no model control;
// explicit selections and invalid model ids must remain visible failures.
async function ensureDelegateSessionWithModelFallback(
  delegate: BaseAcpxRuntime,
  input: OpenClawRuntimeEnsureInput,
): Promise<OpenClawRuntimeHandle> {
  try {
    return await delegate.ensureSession(withAcpxSessionOptions(input));
  } catch (error) {
    if (input.modelExplicit || !input.model || !isAcpModelCapabilityMissingError(error)) {
      throw error;
    }
    return {
      ...(await delegate.ensureSession(withAcpxSessionOptions({ ...input, model: undefined }))),
      appliedModel: { kind: "dropped" },
    };
  }
}

function appendCodexAcpConfigOverrides(
  command: AcpxAgentCommand,
  override: CodexAcpModelOverride,
): AcpxAgentCommand {
  const config = {
    ...(override.model ? { model: override.model } : {}),
    ...(override.reasoningEffort ? { model_reasoning_effort: override.reasoningEffort } : {}),
  };
  if (Object.keys(config).length === 0) {
    return command;
  }
  return [...splitCommandParts(command), OPENCLAW_CODEX_CONFIG_ARG, JSON.stringify(config)];
}

function resolveAgentCommand(params: {
  agentName: string | undefined;
  agentRegistry: AcpAgentRegistry;
}): AcpxAgentCommand | undefined {
  const normalizedAgentName = normalizeAgentName(params.agentName);
  if (!normalizedAgentName) {
    return undefined;
  }
  return splitCommandParts(params.agentRegistry.resolve(normalizedAgentName));
}

function shouldUseDistinctBridgeDelegate(options: AcpRuntimeOptions): boolean {
  const { mcpServers } = options;
  return Array.isArray(mcpServers) && mcpServers.length > 0;
}

function withManagedToolsMcpSessionEnv(params: {
  pluginToolsEnabled: boolean;
  openclawToolsEnabled: boolean;
  mcpServers: AcpRuntimeOptions["mcpServers"];
  sessionKey: string;
  agentId?: string;
}): AcpRuntimeOptions["mcpServers"] {
  const sessionKey = params.sessionKey.trim();
  if (
    (!params.pluginToolsEnabled && !params.openclawToolsEnabled) ||
    !sessionKey ||
    !params.mcpServers?.length
  ) {
    return params.mcpServers;
  }
  let changed = false;
  const nextServers = params.mcpServers.map((server): AcpxMcpServer => {
    const isManagedPluginTools =
      params.pluginToolsEnabled && server.name === ACPX_PLUGIN_TOOLS_MCP_SERVER_NAME;
    const isManagedOpenClawTools =
      params.openclawToolsEnabled && server.name === ACPX_OPENCLAW_TOOLS_MCP_SERVER_NAME;
    if ((!isManagedPluginTools && !isManagedOpenClawTools) || !("command" in server)) {
      return server;
    }
    changed = true;
    const env = [
      ...server.env.filter((entry) => entry.name !== OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV),
      {
        name: OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV,
        value: sessionKey,
      },
    ];
    return {
      ...server,
      env,
      args: params.agentId ? [...server.args, "--openclaw-agent-id", params.agentId] : server.args,
    };
  });
  return changed ? nextServers : params.mcpServers;
}

/** OpenClaw-managed ACP runtime implementation backed by the upstream acpx runtime. */
export class AcpxRuntime implements CompleteAcpRuntime {
  readonly ownerAwareSessions = 1 as const;
  private readonly legacyBareSessionKeys: Set<string>;
  private readonly sessionStore: ResetAwareSessionStore;
  private readonly agentRegistry: AcpAgentRegistry;
  private readonly scopedAgentRegistry: AcpAgentRegistry;
  private readonly launchCommandScope = new AsyncLocalStorage<{
    agent: string;
    command: AcpxAgentCommand | undefined;
  }>();
  private readonly delegate: BaseAcpxRuntime;
  private readonly bridgeSafeDelegate: BaseAcpxRuntime;
  private readonly probeDelegate: BaseAcpxRuntime;
  private readonly probeAgent: string;
  private readonly probeCommand: AcpxAgentCommand | undefined;
  private readonly delegateOptions: AcpRuntimeOptions;
  private readonly delegateTestOptions: BaseAcpxRuntimeTestOptions;
  private readonly pluginToolsMcpBridgeEnabled: boolean;
  private readonly openclawToolsMcpBridgeEnabled: boolean;
  private readonly managedToolsMcpBridgeEnabled: boolean;
  private readonly managedToolsSessionDelegates = new Map<string, BaseAcpxRuntime>();
  private readonly generations = new Map<string, AcpxGeneration>();
  private nextGenerationId = 0;
  private readonly processCleanupDeps: AcpxProcessCleanupDeps | undefined;
  private readonly wrapperRoot: string | undefined;
  private readonly gatewayInstanceId: string | undefined;
  private readonly processLeaseStore: AcpxProcessLeaseStore | undefined;
  private readonly launchLeaseScope = new AsyncLocalStorage<AcpxLaunchLeaseContext | undefined>();
  private readonly processLeaseTransitionQueue = new KeyedAsyncQueue();
  private readonly processLeaseOperationCounts = new Map<string, number>();
  private readonly uncertainProcessLeaseIds = new Set<string>();
  private readonly cwd: string;

  constructor(options: OpenClawAcpxRuntimeOptions, testOptions?: AcpxRuntimeTestOptions) {
    this.legacyBareSessionKeys = new Set(options.openclawLegacyBareSessionKeys);
    const { openclawProcessCleanup, ...delegateTestOptions } = testOptions ?? {};
    this.processCleanupDeps = openclawProcessCleanup;
    this.wrapperRoot = options.openclawWrapperRoot;
    this.gatewayInstanceId = options.openclawGatewayInstanceId;
    this.processLeaseStore = options.openclawProcessLeaseStore;
    this.pluginToolsMcpBridgeEnabled = options.pluginToolsMcpBridgeEnabled === true;
    this.openclawToolsMcpBridgeEnabled = options.openclawToolsMcpBridgeEnabled === true;
    this.managedToolsMcpBridgeEnabled =
      this.pluginToolsMcpBridgeEnabled || this.openclawToolsMcpBridgeEnabled;
    this.cwd = options.cwd;
    this.sessionStore = createResetAwareSessionStore(options.sessionStore, {
      gatewayInstanceId: this.gatewayInstanceId,
      leaseStore: this.processLeaseStore,
      launchScope: this.launchLeaseScope,
      wrapperRoot: this.wrapperRoot,
    });
    this.agentRegistry = options.agentRegistry;
    this.scopedAgentRegistry = {
      resolve: (agentName) => {
        const launch = this.launchCommandScope.getStore();
        return launch && launch.agent === normalizeAgentName(agentName) && launch.command
          ? launch.command
          : this.agentRegistry.resolve(agentName);
      },
      list: () => this.agentRegistry.list(),
    };
    const sharedOptions = {
      ...options,
      sessionStore: this.sessionStore,
      agentRegistry: this.scopedAgentRegistry,
    };
    this.delegateOptions = sharedOptions;
    this.delegateTestOptions = delegateTestOptions as BaseAcpxRuntimeTestOptions;
    this.delegate = new BaseAcpxRuntime(sharedOptions, this.delegateTestOptions);
    this.bridgeSafeDelegate = shouldUseDistinctBridgeDelegate(options)
      ? new BaseAcpxRuntime(
          {
            ...sharedOptions,
            mcpServers: [],
          },
          this.delegateTestOptions,
        )
      : this.delegate;
    this.probeAgent = normalizeAgentName(options.probeAgent) ?? "codex";
    const probeCommand = resolveAgentCommand({
      agentName: this.probeAgent,
      agentRegistry: this.agentRegistry,
    });
    this.probeCommand = probeCommand;
    const useBridgeSafeProbe =
      this.managedToolsMcpBridgeEnabled || isOpenClawBridgeCommand(probeCommand);
    this.probeDelegate = useBridgeSafeProbe ? this.bridgeSafeDelegate : this.delegate;
  }

  private currentGeneration(resource: string): AcpxGeneration {
    let generation = this.generations.get(resource);
    if (!generation) {
      generation = {
        id: ++this.nextGenerationId,
        resource,
        ensureQueue: new KeyedAsyncQueue(),
        retired: false,
        afterReset: this.sessionStore.isFresh(resource),
        awaitPriorWrites: this.sessionStore.isFresh(resource),
      };
      this.generations.set(resource, generation);
    }
    return generation;
  }

  private retireGeneration(generation: AcpxGeneration): void {
    generation.retired = true;
    if (this.generations.get(generation.resource) === generation) {
      this.generations.delete(generation.resource);
      if (this.managedToolsSessionDelegates.get(generation.resource) === generation.delegate) {
        this.managedToolsSessionDelegates.delete(generation.resource);
      }
      this.sessionStore.markFresh(generation.resource);
    }
  }

  private assertCurrentGeneration(generation: AcpxGeneration): void {
    if (generation.retired) {
      throw new AcpRuntimeError(
        "ACP_TURN_FAILED",
        "ACP runtime operation was superseded by reset.",
      );
    }
  }

  private resolveDelegateForSession(params: {
    command: AcpxAgentCommand | undefined;
    sessionKey: string;
    agentId?: string;
  }): BaseAcpxRuntime {
    const generation =
      acpxOperationScope.getStore()?.generation ??
      this.currentGeneration(resolveAcpxSessionResource(params));
    if (generation.delegate) {
      return generation.delegate;
    }
    if (!generation.afterReset) {
      generation.delegate = isOpenClawBridgeCommand(params.command)
        ? this.bridgeSafeDelegate
        : this.resolveManagedToolsDelegateForSession(params);
      return generation.delegate;
    }
    const options = isOpenClawBridgeCommand(params.command)
      ? { ...this.delegateOptions, mcpServers: [] }
      : this.managedToolsMcpBridgeEnabled
        ? {
            ...this.delegateOptions,
            mcpServers: withManagedToolsMcpSessionEnv({
              pluginToolsEnabled: this.pluginToolsMcpBridgeEnabled,
              openclawToolsEnabled: this.openclawToolsMcpBridgeEnabled,
              mcpServers: this.delegateOptions.mcpServers,
              sessionKey: params.sessionKey,
              agentId: params.agentId,
            }),
          }
        : this.delegateOptions;
    generation.delegate = new BaseAcpxRuntime(options, this.delegateTestOptions);
    if (
      this.managedToolsMcpBridgeEnabled &&
      !isOpenClawBridgeCommand(params.command) &&
      !generation.retired
    ) {
      this.managedToolsSessionDelegates.set(generation.resource, generation.delegate);
    }
    return generation.delegate;
  }

  private resolveManagedToolsDelegateForSession(target: {
    sessionKey: string;
    agentId?: string;
  }): BaseAcpxRuntime {
    if (!this.managedToolsMcpBridgeEnabled) {
      return this.delegate;
    }
    const resource = resolveAcpxSessionResource(target);
    const cached = this.managedToolsSessionDelegates.get(resource);
    if (cached) {
      return cached;
    }
    const delegate = new BaseAcpxRuntime(
      {
        ...this.delegateOptions,
        mcpServers: withManagedToolsMcpSessionEnv({
          pluginToolsEnabled: this.pluginToolsMcpBridgeEnabled,
          openclawToolsEnabled: this.openclawToolsMcpBridgeEnabled,
          mcpServers: this.delegateOptions.mcpServers,
          sessionKey: target.sessionKey,
          agentId: target.agentId,
        }),
      },
      this.delegateTestOptions,
    );
    this.managedToolsSessionDelegates.set(resource, delegate);
    return delegate;
  }

  private async loadOperationSnapshotForHandle(
    handle: OpenClawRuntimeHandle,
    allowRetired = false,
  ): Promise<AcpxHandleOperationSnapshot> {
    const resource = assertAcpxSessionOwnerLocator(
      { ...handle, persistedHandle: handle },
      this.legacyBareSessionKeys,
    );
    const generation =
      (handle as GenerationHandle)[acpxGenerationKey] ?? this.currentGeneration(resource);
    if (!allowRetired) {
      this.assertCurrentGeneration(generation);
    }
    const ownedRecord = generation.record;
    if (
      ownedRecord &&
      ((handle.acpxRecordId && ownedRecord.acpxRecordId !== handle.acpxRecordId) ||
        (handle.backendSessionId &&
          ownedRecord.acpSessionId &&
          ownedRecord.acpSessionId !== handle.backendSessionId))
    ) {
      throw new AcpRuntimeError(
        "ACP_TURN_FAILED",
        "ACP handle no longer owns this runtime generation.",
      );
    }
    let record = allowRetired
      ? generation.retired
        ? ownedRecord
        : await this.sessionStore.loadForClose(handle.acpxRecordId ?? resource)
      : await acpxOperationScope.run({ generation }, () =>
          this.sessionStore.load(handle.acpxRecordId ?? resource),
        );
    // A reset can retire this generation while the snapshot read is pending.
    // Prefer its captured record over any replacement now visible in storage.
    if (allowRetired && generation.retired && ownedRecord) {
      record = ownedRecord;
    }
    if (allowRetired && record) {
      generation.record = record;
    }
    if (!allowRetired) {
      this.assertCurrentGeneration(generation);
    }
    if (
      record &&
      ((handle.acpxRecordId && handle.acpxRecordId !== record.acpxRecordId) ||
        (handle.backendSessionId &&
          record.acpSessionId &&
          handle.backendSessionId !== record.acpSessionId))
    ) {
      throw new AcpRuntimeError(
        "ACP_TURN_FAILED",
        "ACP handle no longer owns this runtime record.",
      );
    }
    const command =
      readRecordAgentCommand(record) ??
      resolveAgentCommand({
        agentName: readAgentFromHandle(handle),
        agentRegistry: this.agentRegistry,
      });
    return { record, command, generation };
  }

  private resolveDelegateForOperationSnapshot(
    handle: OpenClawRuntimeHandle,
    snapshot: AcpxHandleOperationSnapshot,
  ): BaseAcpxRuntime {
    return acpxOperationScope.run({ generation: snapshot.generation }, () =>
      this.resolveDelegateForSession({
        command: snapshot.command,
        sessionKey: handle.sessionKey,
        agentId: handle.agentId,
      }),
    );
  }

  private async readReusablePersistentSessionCommand(params: {
    sessionKey: string;
    mode: Parameters<AcpRuntime["ensureSession"]>[0]["mode"];
    cwd: string | undefined;
    command: AcpxAgentCommand | undefined;
    resumeSessionId: string | undefined;
  }): Promise<AcpxAgentCommand | undefined> {
    if (params.mode !== "persistent" || !params.command) {
      return undefined;
    }
    const existing = await this.sessionStore.load(params.sessionKey);
    if (!existing || readRecordResetOnNextEnsure(existing)) {
      return undefined;
    }
    const recordCwd = readRecordCwd(existing);
    if (!recordCwd || resolvePath(recordCwd) !== resolvePath(params.cwd?.trim() || this.cwd)) {
      return undefined;
    }
    const recordCommand = readRecordAgentCommand(existing);
    if (!recordCommand) {
      return undefined;
    }
    const leaseIdentity = readAcpxProcessLeaseIdentity(recordCommand);
    if (leaseIdentity && leaseIdentity.gatewayInstanceId !== this.gatewayInstanceId) {
      return undefined;
    }
    const stableRecordCommand = leaseIdentity
      ? withAcpxLeaseArgs({
          command: params.command,
          leaseId: leaseIdentity.leaseId,
          gatewayInstanceId: leaseIdentity.gatewayInstanceId,
        })
      : params.command;
    if (
      !isDeepStrictEqual(splitCommandParts(recordCommand), splitCommandParts(stableRecordCommand))
    ) {
      return undefined;
    }
    return !params.resumeSessionId || existing.acpSessionId === params.resumeSessionId
      ? recordCommand
      : undefined;
  }

  private async runWithLaunchLease<T>(params: {
    agent: string;
    sessionKey: string;
    command: AcpxAgentCommand | undefined;
    reusableCommand?: AcpxAgentCommand;
    finalizeCompletedProbe?: boolean;
    run: () => Promise<T>;
  }): Promise<T> {
    if (
      !params.command ||
      !this.wrapperRoot ||
      !this.gatewayInstanceId ||
      !this.processLeaseStore ||
      !isOpenClawLeaseAwareAcpxProcessCommand({
        command: params.command,
        wrapperRoot: this.wrapperRoot,
      })
    ) {
      return await this.launchCommandScope.run(
        {
          agent: normalizeAgentName(params.agent) ?? params.agent,
          command: params.reusableCommand ?? params.command,
        },
        params.run,
      );
    }
    const processLeaseStore = this.processLeaseStore;
    const reusableIdentity = readAcpxProcessLeaseIdentity(params.reusableCommand);
    const canReuseLeaseIdentity = reusableIdentity?.gatewayInstanceId === this.gatewayInstanceId;
    // Repeated probes share one uncertainty row per Gateway and wrapper. Unique probe rows could
    // otherwise evict live session ownership from the bounded lease namespace.
    const leaseId = canReuseLeaseIdentity
      ? reusableIdentity.leaseId
      : params.finalizeCompletedProbe
        ? `probe-${hashAcpxProcessCommand(
            `${this.gatewayInstanceId}\0${extractGeneratedWrapperPath(params.command)}`,
          )}`
        : randomUUID();
    const leasedCommand = withAcpxLeaseArgs({
      command: params.command,
      leaseId,
      gatewayInstanceId: this.gatewayInstanceId,
    });
    const launch: AcpxLaunchLeaseContext = {
      leaseId,
      gatewayInstanceId: this.gatewayInstanceId,
      sessionKey: params.sessionKey,
      wrapperRoot: this.wrapperRoot,
      resolvedCommand: params.reusableCommand ?? leasedCommand,
      leasedCommand,
    };
    // Reuse-only adoption cannot spawn: readReusablePersistentSessionCommand
    // mirrors upstream's exact reuse policy. Persist the new command first and
    // let the next reconnect create its matching pending lease.
    await this.retainProcessLeaseOperation(launch, async () => {
      const reusableLease = canReuseLeaseIdentity
        ? await processLeaseStore.load(launch.leaseId)
        : undefined;
      if (
        reusableLease &&
        (reusableLease.gatewayInstanceId !== launch.gatewayInstanceId ||
          reusableLease.sessionKey !== launch.sessionKey ||
          reusableLease.wrapperRoot !== launch.wrapperRoot)
      ) {
        throw new AcpRuntimeError(
          "ACP_SESSION_INIT_FAILED",
          `ACPX process lease ${launch.leaseId} belongs to another session`,
        );
      }
      const ownsPendingLease =
        !reusableLease &&
        (!params.reusableCommand ||
          isDeepStrictEqual(
            splitCommandParts(params.reusableCommand),
            splitCommandParts(leasedCommand),
          ));
      if (!ownsPendingLease) {
        return;
      }
      // The pending lease is written before acpx can spawn. The session-store
      // save fills in the PID; uncertain launch failures leave it for recovery.
      await processLeaseStore.save({
        leaseId: launch.leaseId,
        gatewayInstanceId: launch.gatewayInstanceId,
        sessionKey: launch.sessionKey,
        wrapperRoot: launch.wrapperRoot,
        wrapperPath: extractGeneratedWrapperPath(leasedCommand),
        rootPid: 0,
        commandHash: hashAcpxProcessCommand(leasedCommand),
        startedAt: Date.now(),
        state: "open",
      });
    });
    try {
      const result = await this.launchLeaseScope.run(launch, () =>
        this.launchCommandScope.run(
          {
            agent: normalizeAgentName(params.agent) ?? params.agent,
            command: launch.resolvedCommand,
          },
          params.run,
        ),
      );
      if (params.finalizeCompletedProbe) {
        await this.finalizeCompletedProbeLease(launch);
      } else {
        await this.finalizeProcessLeaseForSession(params.sessionKey, launch);
      }
      return result;
    } catch (error) {
      await this.releaseProcessLeaseAfterUncertainFailure(launch);
      throw error;
    }
  }

  private async prepareProcessLeaseForOperation(
    handle: OpenClawRuntimeHandle,
    record: AcpLoadedSessionRecord,
  ): Promise<AcpxProcessLeaseIdentity | undefined> {
    if (!this.processLeaseStore || !this.gatewayInstanceId || !this.wrapperRoot) {
      return undefined;
    }
    const processLeaseStore = this.processLeaseStore;
    const wrapperRoot = this.wrapperRoot;
    const recordPid = readRecordAgentPid(record);
    const command = readRecordAgentCommand(record);
    const identity = readAcpxProcessLeaseIdentity(command);
    if (
      !command ||
      !isOpenClawLeaseAwareAcpxProcessCommand({
        command,
        wrapperRoot,
      })
    ) {
      return undefined;
    }
    if (!identity) {
      return undefined;
    }
    if (identity.gatewayInstanceId !== this.gatewayInstanceId) {
      throw new AcpRuntimeError(
        "ACP_TURN_FAILED",
        `ACPX process lease ${identity.leaseId} belongs to another gateway`,
      );
    }
    await this.retainProcessLeaseOperation(identity, async () => {
      const existing = await processLeaseStore.load(identity.leaseId);
      if (!existing) {
        // Preserve a PID already persisted with this lease identity. Otherwise
        // reconnect starts from a pending row until upstream saves its new PID.
        await processLeaseStore.save({
          leaseId: identity.leaseId,
          gatewayInstanceId: identity.gatewayInstanceId,
          sessionKey: resolveAcpxSessionResource(handle),
          wrapperRoot,
          wrapperPath: extractGeneratedWrapperPath(command),
          rootPid: recordPid ?? 0,
          commandHash: hashAcpxProcessCommand(command),
          startedAt: Date.now(),
          state: "open",
        });
        return;
      }
      if (
        existing.gatewayInstanceId !== identity.gatewayInstanceId ||
        existing.sessionKey !== resolveAcpxSessionResource(handle) ||
        existing.wrapperRoot !== wrapperRoot
      ) {
        throw new AcpRuntimeError(
          "ACP_TURN_FAILED",
          `ACPX process lease ${identity.leaseId} belongs to another session`,
        );
      }
    });
    return identity;
  }

  private async retainProcessLeaseOperation(
    identity: AcpxProcessLeaseIdentity,
    prepare: () => Promise<void>,
  ): Promise<void> {
    await this.processLeaseTransitionQueue.enqueue(identity.leaseId, async () => {
      await prepare();
      this.processLeaseOperationCounts.set(
        identity.leaseId,
        (this.processLeaseOperationCounts.get(identity.leaseId) ?? 0) + 1,
      );
    });
  }

  private async releaseProcessLeaseOperation(
    identity: AcpxProcessLeaseIdentity | undefined,
    finalize: () => Promise<void>,
  ): Promise<void> {
    if (!identity) {
      return;
    }
    await this.processLeaseTransitionQueue.enqueue(identity.leaseId, async () => {
      const count = this.processLeaseOperationCounts.get(identity.leaseId) ?? 0;
      if (count > 1) {
        this.processLeaseOperationCounts.set(identity.leaseId, count - 1);
        return;
      }
      if (count === 0) {
        return;
      }
      // Keep the zero-owner check and retirement in one lease-local transition.
      // Otherwise a reconnect can retain a row while an older owner deletes it.
      this.processLeaseOperationCounts.delete(identity.leaseId);
      await finalize();
    });
  }

  private async finalizeProcessLeaseForOperation(
    handle: OpenClawRuntimeHandle,
    identity: AcpxProcessLeaseIdentity | undefined,
  ): Promise<void> {
    await this.finalizeProcessLeaseForSession(
      handle.acpxRecordId ?? resolveAcpxSessionResource(handle),
      identity,
    );
  }

  private async finalizeProcessLeaseForSession(
    sessionId: string,
    identity: AcpxProcessLeaseIdentity | undefined,
  ): Promise<void> {
    if (!identity || !this.processLeaseStore) {
      return;
    }
    const processLeaseStore = this.processLeaseStore;
    await this.releaseProcessLeaseOperation(identity, async () => {
      const lease = await processLeaseStore.load(identity.leaseId);
      if (!lease || lease.gatewayInstanceId !== identity.gatewayInstanceId) {
        return;
      }
      if (lease.rootPid <= 0) {
        if (this.uncertainProcessLeaseIds.has(identity.leaseId)) {
          return;
        }
        await processLeaseStore.markState(identity.leaseId, "lost");
        return;
      }
      this.uncertainProcessLeaseIds.delete(identity.leaseId);
      try {
        const record = await this.sessionStore.load(sessionId);
        const recordIdentity = readAcpxProcessLeaseIdentity(readRecordAgentCommand(record));
        if (
          recordIdentity?.leaseId !== identity.leaseId ||
          recordIdentity.gatewayInstanceId !== identity.gatewayInstanceId
        ) {
          await processLeaseStore.markState(identity.leaseId, "lost");
        }
      } catch {
        // Preserve a PID-bearing lease for startup verification when record reload
        // fails; deleting it here could lose the only cleanup identity.
      }
    });
  }

  private async finalizeCompletedProbeLease(identity: AcpxLaunchLeaseContext): Promise<void> {
    if (!this.processLeaseStore) {
      return;
    }
    const processLeaseStore = this.processLeaseStore;
    await this.releaseProcessLeaseOperation(identity, async () => {
      const lease = await processLeaseStore.load(identity.leaseId);
      if (!lease || lease.gatewayInstanceId !== identity.gatewayInstanceId) {
        return;
      }
      // Upstream probe close is bounded and best-effort. Delegate fulfillment
      // does not prove the wrapper exited, so verify the exact pending identity.
      // Keep the lease even when the wrapper is absent: its detached adapter
      // descendants do not carry lease args and may already be reparented.
      if (lease.rootPid > 0) {
        return;
      }
      await cleanupOpenClawOwnedAcpxPendingLease({
        leaseId: lease.leaseId,
        gatewayInstanceId: lease.gatewayInstanceId,
        wrapperRoot: lease.wrapperRoot,
        wrapperPath: lease.wrapperPath,
        deps: this.processCleanupDeps,
      });
    });
  }

  private async releaseProcessLeaseAfterUncertainFailure(
    identity: AcpxProcessLeaseIdentity | undefined,
  ): Promise<void> {
    if (!identity || !this.processLeaseStore) {
      return;
    }
    this.uncertainProcessLeaseIds.add(identity.leaseId);
    const processLeaseStore = this.processLeaseStore;
    await this.releaseProcessLeaseOperation(identity, async () => {
      const lease = await processLeaseStore.load(identity.leaseId);
      if (!lease || lease.gatewayInstanceId !== identity.gatewayInstanceId || lease.rootPid > 0) {
        this.uncertainProcessLeaseIds.delete(identity.leaseId);
      }
    });
  }

  private async runWithProcessLeaseForHandle<T>(
    handle: OpenClawRuntimeHandle,
    record: AcpLoadedSessionRecord,
    run: () => Promise<T>,
  ): Promise<T> {
    const identity = await this.prepareProcessLeaseForOperation(handle, record);
    try {
      return await run();
    } finally {
      await this.finalizeProcessLeaseForOperation(handle, identity);
    }
  }

  private async finalizeProcessLeaseAfter<T>(
    handle: OpenClawRuntimeHandle,
    identityPromise: Promise<AcpxProcessLeaseIdentity | undefined>,
    resultPromise: Promise<T>,
  ): Promise<T> {
    try {
      return await resultPromise;
    } finally {
      await this.finalizeProcessLeaseForOperation(handle, await identityPromise);
    }
  }

  private async withCodexWrapperDiagnostics<T>(params: {
    command: AcpxAgentCommand | undefined;
    fallbackCode: AcpRuntimeErrorCode;
    handle?: OpenClawRuntimeHandle;
    run: () => Promise<T>;
  }): Promise<T> {
    try {
      return await params.run();
    } catch (error) {
      if (!isCodexAcpCommand(params.command) || !isGenericInternalAcpError(error)) {
        throw error;
      }
      const stderrTail = params.handle
        ? await this.readCodexTurnFailureStderr({ handle: params.handle })
        : await readCodexWrapperStderrTail({
            wrapperRoot: this.wrapperRoot,
            leaseId: this.launchLeaseScope.getStore()?.leaseId,
          });
      if (!stderrTail) {
        throw error;
      }
      throw new AcpRuntimeError(params.fallbackCode, `Internal error: ${stderrTail}`, {
        cause: error,
      });
    }
  }

  private async readCodexTurnFailureStderr(params: {
    handle: OpenClawRuntimeHandle;
  }): Promise<string> {
    const record = await this.sessionStore.load(
      params.handle.acpxRecordId ?? resolveAcpxSessionResource(params.handle),
    );
    return readCodexWrapperStderrTail({
      wrapperRoot: this.wrapperRoot,
      leaseId: readOpenClawLeaseIdFromRecord(record),
    });
  }

  private async cleanupProcessTreeForRecord(
    handle: OpenClawRuntimeHandle,
    record: AcpLoadedSessionRecord,
  ): Promise<void> {
    const leaseId = readOpenClawLeaseIdFromRecord(record);
    const rootPid = readRecordAgentPid(record);
    const sessionKeys = [resolveAcpxSessionResource(handle), readSessionRecordName(record)];
    const openLeases =
      this.gatewayInstanceId && this.processLeaseStore
        ? await this.processLeaseStore.listOpen(this.gatewayInstanceId)
        : [];
    const selectedLease = selectCurrentSessionLease({
      leases: openLeases,
      sessionKeys,
      rootPid,
    });
    const loadedLease = leaseId ? await this.processLeaseStore?.load(leaseId) : undefined;
    const lease =
      selectedLease ??
      (loadedLease &&
      loadedLease.gatewayInstanceId === this.gatewayInstanceId &&
      (!rootPid || loadedLease.rootPid === rootPid) &&
      sessionKeys.includes(loadedLease.sessionKey)
        ? loadedLease
        : undefined);
    if (lease && lease.gatewayInstanceId === this.gatewayInstanceId && lease.rootPid > 0) {
      await this.processLeaseStore?.markState(lease.leaseId, "closing");
      const result = await cleanupOpenClawOwnedAcpxProcessTree({
        rootPid: lease.rootPid,
        rootCommand: record?.agentCommand,
        expectedLeaseId: lease.leaseId,
        expectedGatewayInstanceId: lease.gatewayInstanceId,
        wrapperRoot: lease.wrapperRoot,
        deps: this.processCleanupDeps,
      });
      await this.processLeaseStore?.markState(
        lease.leaseId,
        result.skippedReason === "process-list-unavailable" ||
          result.skippedReason === "unsupported-platform"
          ? "open"
          : result.terminatedPids.length > 0 || result.skippedReason === "missing-root"
            ? "closed"
            : "lost",
      );
      return;
    }

    const rootCommand =
      readRecordAgentCommand(record) ??
      resolveAgentCommand({
        agentName: readAgentFromHandle(handle),
        agentRegistry: this.agentRegistry,
      });
    if (!rootPid || !rootCommand) {
      return;
    }
    const expectedGatewayInstanceId = readOpenClawGatewayInstanceIdFromRecord(record);
    await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid,
      rootCommand: renderAgentCommand(rootCommand),
      ...(leaseId ? { expectedLeaseId: leaseId } : {}),
      ...(expectedGatewayInstanceId ? { expectedGatewayInstanceId } : {}),
      wrapperRoot: this.wrapperRoot,
      deps: this.processCleanupDeps,
    });
  }

  isHealthy(): boolean {
    return this.probeDelegate.isHealthy();
  }

  async probeAvailability(): Promise<void> {
    await this.runWithLaunchLease({
      agent: this.probeAgent,
      sessionKey: ACPX_PROBE_LEASE_SESSION_KEY,
      command: this.probeCommand,
      finalizeCompletedProbe: true,
      run: () => this.probeDelegate.probeAvailability(),
    });
  }

  async doctor(): Promise<AcpRuntimeDoctorReport> {
    return await this.runWithLaunchLease({
      agent: this.probeAgent,
      sessionKey: ACPX_PROBE_LEASE_SESSION_KEY,
      command: this.probeCommand,
      finalizeCompletedProbe: true,
      run: () => this.probeDelegate.doctor(),
    });
  }

  async ensureSession(
    input: Parameters<AcpRuntime["ensureSession"]>[0],
  ): Promise<OpenClawRuntimeHandle> {
    const resource = assertAcpxSessionOwnerLocator(input, this.legacyBareSessionKeys);
    const generation = this.currentGeneration(resource);
    return await generation.ensureQueue.enqueue(resource + "\u0000" + generation.id, () =>
      acpxOperationScope.run({ generation }, async () => {
        this.assertCurrentGeneration(generation);
        const handle = await this.ensureSessionUnlocked(input);
        return { ...handle, [acpxGenerationKey]: generation };
      }),
    );
  }

  private async ensureSessionUnlocked(
    logicalInput: Parameters<AcpRuntime["ensureSession"]>[0],
  ): Promise<OpenClawRuntimeHandle> {
    assertSupportedRuntimeSessionMode(logicalInput.mode);
    const command = resolveAgentCommand({
      agentName: logicalInput.agent,
      agentRegistry: this.agentRegistry,
    });
    const delegate = this.resolveDelegateForSession({
      command,
      sessionKey: logicalInput.sessionKey,
      agentId: logicalInput.agentId,
    });
    const logicalTarget = { sessionKey: logicalInput.sessionKey, agentId: logicalInput.agentId };
    const input = { ...logicalInput, sessionKey: resolveAcpxSessionResource(logicalInput) };
    const isCodexAcp =
      normalizeAgentName(input.agent) === CODEX_ACP_AGENT_ID && isCodexAcpCommand(command);
    const dropInheritedCodexMax =
      isCodexAcp && input.thinking === "max" && input.thinkingExplicit === false;
    const effectiveInput = dropInheritedCodexMax ? { ...input } : input;
    if (dropInheritedCodexMax) {
      delete effectiveInput.thinking;
    }
    const claudeModelOverride = isClaudeAcpCommand(command)
      ? normalizeClaudeAcpModelOverride(input.model)
      : undefined;
    const codexClassification = isCodexAcp
      ? classifyCodexAcpModelRequest(effectiveInput.model, effectiveInput.thinking)
      : undefined;
    if (codexClassification?.kind === "unsupported" && input.modelExplicit) {
      failUnsupportedCodexAcpModel(input.model ?? "");
    }
    const classifiedCodexOverride =
      codexClassification?.kind === "override"
        ? codexClassification.override
        : codexClassification?.thinkingOverride;
    const codexModelOverride =
      classifiedCodexOverride && Object.keys(classifiedCodexOverride).length > 0
        ? classifiedCodexOverride
        : undefined;
    const requestedModel = effectiveInput.model?.trim();
    const appliedModel: OpenClawRuntimeHandle["appliedModel"] =
      isCodexAcp && requestedModel
        ? codexModelOverride?.model
          ? { kind: "applied", model: requestedModel }
          : { kind: "dropped" }
        : undefined;
    const ensureInput = isCodexAcp
      ? withCodexSessionModel(effectiveInput, codexModelOverride)
      : claudeModelOverride
        ? { ...effectiveInput, model: claudeModelOverride }
        : effectiveInput;
    const stableLaunchCommand =
      codexModelOverride && command
        ? appendCodexAcpConfigOverrides(command, codexModelOverride)
        : command;
    const reusableCommand = await this.readReusablePersistentSessionCommand({
      sessionKey: input.sessionKey,
      mode: input.mode,
      cwd: input.cwd,
      command: stableLaunchCommand,
      resumeSessionId: input.resumeSessionId,
    });

    const handle = await this.runWithLaunchLease({
      agent: ensureInput.agent,
      sessionKey: ensureInput.sessionKey,
      command: stableLaunchCommand,
      reusableCommand,
      run: () =>
        this.withCodexWrapperDiagnostics({
          command: stableLaunchCommand,
          fallbackCode: "ACP_SESSION_INIT_FAILED",
          run: () =>
            codexModelOverride
              ? delegate.ensureSession(withAcpxSessionOptions(ensureInput))
              : ensureDelegateSessionWithModelFallback(delegate, ensureInput),
        }),
    });
    return {
      ...handle,
      ...logicalTarget,
      ...(appliedModel ? { appliedModel } : {}),
      ...(dropInheritedCodexMax ? { appliedThinking: { kind: "dropped" as const } } : {}),
    };
  }

  async *runTurn(input: Parameters<AcpRuntime["runTurn"]>[0]): AsyncIterable<AcpRuntimeEvent> {
    const turn = this.startTurn(input);
    // Observe terminal rejection while the consumer is still reading events.
    void turn.result.catch(() => {});
    let completed = false;
    try {
      yield* turn.events;
      const result = await turn.result;
      completed = true;
      yield result.status === "failed"
        ? { type: "error", ...result.error }
        : { type: "done", ...(result.stopReason ? { stopReason: result.stopReason } : {}) };
    } finally {
      if (!completed) {
        // Ending iteration closes only the consumer. The turn result owns lease cleanup.
        await turn.cancel({ reason: "stream-closed" }).catch(() => {});
        await turn.closeStream({ reason: "stream-closed" }).catch(() => {});
        await turn.result.catch(() => {});
      }
    }
  }

  startTurn(input: OpenClawRuntimeTurnInput): CompleteAcpRuntimeTurn {
    const withTurnDiagnostics = <T>(command: AcpxAgentCommand | undefined, run: () => Promise<T>) =>
      this.withCodexWrapperDiagnostics({
        command,
        handle: input.handle,
        fallbackCode: "ACP_TURN_FAILED",
        run,
      });
    const snapshotPromise = this.loadOperationSnapshotForHandle(input.handle);
    const turnLeasePromise = snapshotPromise.then(({ record }) =>
      this.prepareProcessLeaseForOperation(input.handle, record),
    );
    const turnPromise = Promise.all([snapshotPromise, turnLeasePromise]).then(([snapshot]) => {
      const { command } = snapshot;
      const delegate = this.resolveDelegateForOperationSnapshot(input.handle, snapshot);
      this.assertCurrentGeneration(snapshot.generation);
      return acpxOperationScope.run({ generation: snapshot.generation }, () =>
        withTurnDiagnostics(command, async () => ({
          command,
          turn: delegate.startTurn({
            ...toAcpxResourceInput(input),
            // OpenClaw owns deadlines; acpx timeouts can report partial output as completed.
            timeoutMs: 0,
          }),
        })),
      );
    });

    return {
      requestId: input.requestId,
      get promptStarted() {
        return turnPromise.then(({ turn }) => turn.promptStarted);
      },
      events: {
        async *[Symbol.asyncIterator](): AsyncIterator<AcpRuntimeEvent> {
          const { command, turn } = await turnPromise;
          try {
            yield* turn.events;
          } catch (error) {
            if (!isGenericInternalAcpError(error)) {
              throw error;
            }
            await withTurnDiagnostics(command, () => Promise.reject(error));
          }
        },
      },
      result: this.finalizeProcessLeaseAfter(
        input.handle,
        turnLeasePromise,
        turnPromise.then(({ command, turn }) =>
          withTurnDiagnostics(command, async (): Promise<AcpRuntimeTurnResult> => {
            const result = await turn.result;
            if (
              result.status !== "failed" ||
              !isCodexAcpCommand(command) ||
              !isGenericInternalAcpErrorMessage(result.error.message)
            ) {
              return result;
            }
            const stderrTail = await this.readCodexTurnFailureStderr({ handle: input.handle });
            if (!stderrTail) {
              return result;
            }
            return {
              status: "failed",
              error: {
                ...result.error,
                code: "ACP_TURN_FAILED",
                message: `Internal error: ${stderrTail}`,
              },
            };
          }),
        ),
      ),
      cancel(inputArgs?: { reason?: string }) {
        return turnPromise.then(({ turn }) => turn.cancel(inputArgs));
      },
      closeStream(inputArgs?: { reason?: string }) {
        return turnPromise.then(({ turn }) => turn.closeStream(inputArgs));
      },
    };
  }

  getCapabilities(
    input?: Parameters<NonNullable<AcpRuntime["getCapabilities"]>>[0],
  ): ReturnType<BaseAcpxRuntime["getCapabilities"]> {
    return this.delegate.getCapabilities(
      input?.handle ? toAcpxResourceInput({ handle: input.handle }) : input,
    );
  }

  async getStatus(
    input: Parameters<NonNullable<AcpRuntime["getStatus"]>>[0],
  ): Promise<AcpRuntimeStatus> {
    const snapshot = await this.loadOperationSnapshotForHandle(input.handle);
    return acpxOperationScope.run({ generation: snapshot.generation }, () =>
      this.resolveDelegateForOperationSnapshot(input.handle, snapshot).getStatus(
        toAcpxResourceInput(input),
      ),
    );
  }

  async setMode(input: Parameters<NonNullable<AcpRuntime["setMode"]>>[0]): Promise<void> {
    const snapshot = await this.loadOperationSnapshotForHandle(input.handle);
    await acpxOperationScope.run({ generation: snapshot.generation }, () =>
      this.runWithProcessLeaseForHandle(input.handle, snapshot.record, () =>
        this.resolveDelegateForOperationSnapshot(input.handle, snapshot).setMode(
          toAcpxResourceInput(input),
        ),
      ),
    );
  }

  async setConfigOption(
    input: Parameters<NonNullable<AcpRuntime["setConfigOption"]>>[0],
  ): ReturnType<NonNullable<AcpRuntime["setConfigOption"]>> {
    const snapshot = await this.loadOperationSnapshotForHandle(input.handle);
    return await acpxOperationScope.run({ generation: snapshot.generation }, () =>
      this.runWithProcessLeaseForHandle(input.handle, snapshot.record, () =>
        this.setConfigOptionUnlocked(input, snapshot),
      ),
    );
  }

  private async setConfigOptionUnlocked(
    logicalInput: Parameters<NonNullable<AcpRuntime["setConfigOption"]>>[0],
    snapshot: AcpxHandleOperationSnapshot,
  ): ReturnType<NonNullable<AcpRuntime["setConfigOption"]>> {
    const { command } = snapshot;
    const delegate = this.resolveDelegateForOperationSnapshot(logicalInput.handle, snapshot);
    const input = toAcpxResourceInput(logicalInput);
    const key = input.key.trim().toLowerCase();
    const isCodexAcp = isCodexAcpCommand(command);
    if (WIRE_TIMEOUT_CONFIG_KEYS.has(key) && (isCodexAcp || isClaudeAcpCommand(command))) {
      return;
    }
    if (isCodexAcp) {
      if (key === "model") {
        const classification = classifyCodexAcpModelRequest(input.value);
        if (classification.kind === "unsupported") {
          failUnsupportedCodexAcpModel(input.value);
        }
        const { override } = classification;
        const modelResult = override.model
          ? await delegate.setConfigOption({ ...input, key: "model", value: override.model })
          : undefined;
        this.assertCurrentGeneration(snapshot.generation);
        if (override.reasoningEffort) {
          return await delegate.setConfigOption({
            ...input,
            key: "reasoning_effort",
            value: override.reasoningEffort,
          });
        }
        return modelResult;
      }
      if (key === "thinking" || key === "thought_level" || key === "reasoning_effort") {
        const classification = classifyCodexAcpModelRequest(undefined, input.value);
        const reasoningEffort =
          classification.kind === "override" ? classification.override.reasoningEffort : undefined;
        if (!reasoningEffort) {
          // `off` omits the startup override; Codex has no live control to unset effort.
          throw new AcpRuntimeError(
            "ACP_BACKEND_UNSUPPORTED_CONTROL",
            "Clearing Codex reasoning effort on an existing session is unsupported. Choose a supported explicit effort; the current effort is unchanged.",
          );
        }
        return await delegate.setConfigOption({
          ...input,
          key: "reasoning_effort",
          value: reasoningEffort,
        });
      }
    }
    if (isClaudeAcpCommand(command) && key === "model") {
      return await delegate.setConfigOption({
        ...input,
        value: normalizeClaudeAcpModelOverride(input.value) ?? input.value,
      });
    }
    return await delegate.setConfigOption(input);
  }

  async cancel(input: Parameters<AcpRuntime["cancel"]>[0]): Promise<void> {
    const snapshot = await this.loadOperationSnapshotForHandle(input.handle);
    await acpxOperationScope.run({ generation: snapshot.generation }, () =>
      this.resolveDelegateForOperationSnapshot(input.handle, snapshot).cancel(
        toAcpxResourceInput(input),
      ),
    );
  }

  async prepareFreshSession(
    input: Parameters<NonNullable<AcpRuntime["prepareFreshSession"]>>[0],
  ): Promise<void> {
    // Fresh reset has no ACP handle to close the delegate's upstream client.
    // Keep the scoped delegate reachable so the next ensure can replace it;
    // close() owns cache release when the session lifecycle ends.
    const resource = assertAcpxSessionOwnerLocator(input, this.legacyBareSessionKeys);
    const generation = this.generations.get(resource);
    if (generation) {
      this.retireGeneration(generation);
    } else {
      this.sessionStore.markFresh(resource);
    }
    // The validated reset retires this startup record before metadata is cleared.
    this.legacyBareSessionKeys.delete(resource);
  }

  async close(input: Parameters<AcpRuntime["close"]>[0]): Promise<void> {
    const snapshot = await this.loadOperationSnapshotForHandle(input.handle, true);
    const generation = snapshot.generation;
    const closeLease = await this.prepareProcessLeaseForOperation(input.handle, snapshot.record);
    const delegate = this.resolveDelegateForOperationSnapshot(input.handle, snapshot);
    // Detach before a backend close can hang. Its snapshot remains available only
    // to this operation; the new generation has independent upstream locks.
    if (input.discardPersistentState) {
      this.retireGeneration(generation);
      this.legacyBareSessionKeys.delete(generation.resource);
    }
    let cleanupSucceeded = false;
    try {
      try {
        await acpxOperationScope.run({ generation, closeRecord: snapshot.record }, () =>
          delegate.close({
            handle: toAcpxResourceInput(input).handle,
            reason: input.reason,
            discardPersistentState: input.discardPersistentState,
          }),
        );
        if (!generation.retired && this.generations.get(generation.resource) === generation) {
          generation.retired = true;
          if (this.managedToolsSessionDelegates.get(generation.resource) === delegate) {
            this.managedToolsSessionDelegates.delete(generation.resource);
          }
          this.generations.delete(generation.resource);
        }
      } finally {
        await this.cleanupProcessTreeForRecord(input.handle, snapshot.record);
        cleanupSucceeded = true;
      }
    } finally {
      if (cleanupSucceeded) {
        await this.finalizeProcessLeaseForOperation(input.handle, closeLease);
      } else {
        await this.releaseProcessLeaseAfterUncertainFailure(closeLease);
      }
    }
  }
}

export {
  ACPX_BACKEND_ID,
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  decodeAcpxRuntimeHandleState,
  encodeAcpxRuntimeHandleState,
};

/** Test-only hooks for ACPX runtime behavior that is otherwise private. */
export const testing = {
  appendCodexAcpConfigOverrides,
  isClaudeAcpCommand,
  isCodexAcpCommand,
};

export type { AcpAgentRegistry, AcpRuntimeOptions, AcpSessionRecord, AcpSessionStore };
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
