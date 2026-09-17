import { AcpxRuntime as BaseAcpxRuntime } from "acpx/runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpRuntime } from "../runtime-api.js";
import type { AcpSessionStore } from "./runtime.js";
import {
  type TestSessionStore,
  makeRuntime,
  makeManagedDelegateRuntime,
} from "./runtime.test-support.js";

describe("AcpxRuntime reset generation custody", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("keeps stale persistent loads hidden until a fresh record is saved", async () => {
    let persisted: Record<string, unknown> = { acpxRecordId: "stale" };
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => persisted),
      save: vi.fn(async (record) => {
        persisted = record;
      }),
    };

    const { runtime, wrappedStore } = makeRuntime(baseStore);

    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toEqual({
      acpxRecordId: "stale",
    });
    expect(baseStore["load"]).toHaveBeenCalledTimes(1);

    await runtime.prepareFreshSession({
      sessionKey: "agent:codex:acp:binding:test",
    });

    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toBeUndefined();
    expect(baseStore["load"]).toHaveBeenCalledTimes(1);
    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toBeUndefined();
    expect(baseStore["load"]).toHaveBeenCalledTimes(1);

    await wrappedStore.save({
      acpxRecordId: "agent:codex:acp:binding:test",
      name: "agent:codex:acp:binding:test",
      acpSessionId: "fresh-session",
    } as never);

    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toMatchObject({
      acpxRecordId: "agent:codex:acp:binding:test",
      acpSessionId: "fresh-session",
    });
    expect(baseStore["load"]).toHaveBeenCalledTimes(2);
  });

  it("fences persistence from a runtime option that finishes after reset", async () => {
    const sessionKey = "agent:codex:acp:binding:test";
    const oldRecord = { acpxRecordId: "old-record", name: sessionKey, acpSessionId: "old-session" };
    let persisted: Record<string, unknown> = oldRecord;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => persisted),
      save: vi.fn(async (record) => {
        persisted = record;
      }),
    };
    const { runtime, wrappedStore, delegate } = makeRuntime(baseStore);
    let release: (() => void) | undefined;
    vi.spyOn(delegate, "setMode").mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await wrappedStore.save({ ...oldRecord, sessionMode: "stale" });
    });
    const pending = runtime.setMode({
      handle: { sessionKey, backend: "acpx", runtimeSessionName: sessionKey },
      mode: "stale",
    });
    await vi.waitFor(() => expect(release).toEqual(expect.any(Function)));
    await runtime.prepareFreshSession({ sessionKey });
    await wrappedStore.save({
      acpxRecordId: "fresh-record",
      name: sessionKey,
      acpSessionId: "fresh-session",
    });
    release?.();
    await pending;
    expect(persisted).toMatchObject({ acpSessionId: "fresh-session" });
  });

  it("keeps a fresh generation owned when an older discard close finishes late", async () => {
    const sessionKey = "agent:codex:acp:binding:test";
    const oldRecord: Record<string, unknown> = {
      acpxRecordId: sessionKey,
      name: sessionKey,
      acpSessionId: "old-session",
    };
    let persisted = oldRecord;
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => persisted),
      save: vi.fn(async (record) => {
        persisted = record;
      }),
    };
    const { runtime, wrappedStore } = makeRuntime(baseStore, {
      openclawToolsMcpBridgeEnabled: true,
      mcpServers: [
        {
          name: "openclaw-tools",
          command: "node",
          args: ["dist/mcp/openclaw-tools-serve.js"],
          env: [],
        },
      ],
    });
    const exposedRuntime = runtime as unknown as {
      managedToolsSessionDelegates: Map<string, { close: AcpRuntime["close"] }>;
      resolveManagedToolsDelegateForSession(target: { sessionKey: string }): {
        close: AcpRuntime["close"];
      };
    };
    const scopedDelegate = exposedRuntime.resolveManagedToolsDelegateForSession({ sessionKey });
    let releaseClose: (() => void) | undefined;
    vi.spyOn(scopedDelegate, "close").mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      oldRecord.closed = true;
      oldRecord.acpx = { reset_on_next_ensure: true };
      await wrappedStore.save(oldRecord);
    });

    const closePromise = runtime.close({
      handle: {
        sessionKey,
        backend: "acpx",
        runtimeSessionName: sessionKey,
      },
      reason: "new-in-place-reset",
      discardPersistentState: true,
    });
    await vi.waitFor(() => expect(releaseClose).toEqual(expect.any(Function)));
    await runtime.prepareFreshSession({ sessionKey });
    await wrappedStore.save({
      acpxRecordId: sessionKey,
      name: sessionKey,
      acpSessionId: "fresh-session",
    });

    releaseClose?.();
    await closePromise;

    expect(persisted).toMatchObject({ acpSessionId: "fresh-session" });
    expect(await wrappedStore.load(sessionKey)).toMatchObject({ acpSessionId: "fresh-session" });
    expect(exposedRuntime.managedToolsSessionDelegates.has(sessionKey)).toBe(false);
  });

  it("keeps a background discard close attached to the pre-reset record", async () => {
    const sessionKey = "agent:codex:acp:binding:test";
    const oldRecord: Record<string, unknown> = {
      acpxRecordId: sessionKey,
      name: sessionKey,
      acpSessionId: "old-session",
    };
    const load = vi.fn(async () => oldRecord);
    const baseStore: TestSessionStore = {
      load,
      save: vi.fn(async () => {}),
    };
    const { runtime, wrappedStore, delegate } = makeRuntime(baseStore);
    await expect(wrappedStore.load(sessionKey)).resolves.toBe(oldRecord);
    const baseLoadCount = load.mock.calls.length;
    const close = vi.spyOn(delegate, "close").mockImplementation(async () => {
      expect(await wrappedStore.load(sessionKey)).toMatchObject(oldRecord);
    });

    const closePromise = runtime.close({
      handle: {
        sessionKey,
        backend: "acpx",
        runtimeSessionName: sessionKey,
      },
      reason: "new-in-place-reset",
      discardPersistentState: true,
    });
    await runtime.prepareFreshSession({ sessionKey });
    await closePromise;

    expect(close).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledTimes(baseLoadCount + 1);
  });

  it("marks the session fresh after discardPersistentState close", async () => {
    const baseStore: TestSessionStore = {
      load: vi.fn(async () => ({ acpxRecordId: "stale" }) as never),
      save: vi.fn(async () => {}),
    };

    const { runtime, wrappedStore, delegate } = makeRuntime(baseStore);
    const close = vi.spyOn(delegate, "close").mockResolvedValue(undefined);

    await runtime.close({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      reason: "new-in-place-reset",
      discardPersistentState: true,
    });

    expect(close).toHaveBeenCalledWith({
      handle: {
        sessionKey: "agent:codex:acp:binding:test",
        backend: "acpx",
        runtimeSessionName: "agent:codex:acp:binding:test",
      },
      reason: "new-in-place-reset",
      discardPersistentState: true,
    });
    expect(await wrappedStore.load("agent:codex:acp:binding:test")).toBeUndefined();
    expect(baseStore["load"]).toHaveBeenCalledOnce();
  });

  it.each(["success", "cleanup-failure", "close-failure"] as const)(
    "retires only successfully closed managed delegates after %s",
    async (outcome) => {
      const { runtime, target, resource, delegates, baseStore, sleep, ensure } =
        makeManagedDelegateRuntime();
      const handle = await ensure();
      const first = delegates.get(resource);
      expect(first).toBeDefined();
      expect(delegates.has(target.sessionKey)).toBe(false);
      if (outcome === "cleanup-failure") {
        sleep.mockRejectedValueOnce(new Error("cleanup failed"));
      }
      if (outcome === "close-failure") {
        baseStore.save.mockRejectedValueOnce(new Error("close failed"));
      }
      const closing = runtime.close({ handle, reason: "closed" });
      if (outcome === "success") {
        await closing;
      } else {
        await expect(closing).rejects.toThrow(
          outcome === "cleanup-failure" ? "cleanup failed" : "close failed",
        );
      }
      expect(delegates.size).toBe(outcome === "close-failure" ? 1 : 0);
      expect((await baseStore.load()).closed).toBe(outcome !== "close-failure");
      const next = await ensure();
      if (outcome === "close-failure") {
        expect(delegates.get(resource)).toBe(first);
      } else {
        expect(delegates.get(resource)).not.toBe(first);
      }
      expect(next.sessionKey).toBe(target.sessionKey);
      expect(next.agentId).toBe(target.agentId);
      await runtime.close({ handle: next, reason: "closed" });
      expect(delegates.size).toBe(0);
    },
  );

  it.each([false, true])(
    "does not evict a replacement after overlapping closes (reset: %s)",
    async (afterReset) => {
      const { runtime, target, resource, delegates, baseStore, ensure } =
        makeManagedDelegateRuntime();
      let handle = await ensure();
      if (afterReset) {
        await runtime.prepareFreshSession(target);
        const freshRecord = { ...(await baseStore.load()), acpSessionId: "fresh-session" };
        const wrappedStore = Reflect.get(runtime, "sessionStore") as AcpSessionStore;
        // Isolate adapter creation; both overlapping closes use the real upstream runtime.
        const create = vi
          .spyOn(BaseAcpxRuntime.prototype, "ensureSession")
          .mockImplementationOnce(async () => {
            await wrappedStore.save(freshRecord);
            return { ...handle, backendSessionId: "fresh-session" };
          });
        try {
          handle = await ensure();
        } finally {
          create.mockRestore();
        }
      }
      const first = delegates.get(resource);
      const closingStarted = createDeferred<void>();
      const releaseClose = createDeferred<void>();
      const save = baseStore.save.getMockImplementation()!;
      baseStore.save.mockImplementationOnce(async (record) => {
        closingStarted.resolve();
        await releaseClose.promise;
        await save(record);
      });
      const firstClose = runtime.close({ handle, reason: "older close" });
      try {
        await closingStarted.promise;
        await runtime.close({ handle, reason: "concurrent close" });
        expect(delegates.size).toBe(0);
        const next = await ensure();
        const replacement = delegates.get(resource);
        expect(replacement).toBeDefined();
        expect(replacement).not.toBe(first);
        releaseClose.resolve();
        await firstClose;
        expect(delegates.get(resource)).toBe(replacement);
        await runtime.close({ handle: next, reason: "final close" });
        expect(delegates.size).toBe(0);
      } finally {
        releaseClose.resolve();
        await firstClose;
      }
    },
  );
});
