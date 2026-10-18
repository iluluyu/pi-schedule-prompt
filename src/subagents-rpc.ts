// Minimal client for pi-subagents' cross-extension RPC (docs/rpc.md, protocol
// v2). All calls are in-process pi.events emit/on round-trips — no imports of
// the pi-subagents package, so this degrades gracefully when it is absent.
//
// Used by the scheduler as the default subagent runner: beats spawned this way
// are visible and steerable in the user's existing /agents conversation views.
//
// Wire notes verified against the host source:
// - ping reply is {success:true, data:{version:2}} — check the version.
// - spawn reply is {success:true, data:{id}} and arrives only after the agent
//   finished STARTING UP (awaitStartup); queue time does not delay it, but
//   startup (e.g. worktree isolation) can take a while.
// - completed/failed carry {id, result?, error?, status?} with string
//   result/error.
// - consume must fire synchronously inside the completed/failed listener to
//   beat the host's notification scheduling (it does — the side effect runs
//   during our synchronous emit).

/** Lifecycle event payload subset we consume. */
interface AgentLifecycleEvent {
  id?: string;
  result?: unknown;
  error?: unknown;
  status?: unknown;
}

export interface SpawnOptions {
  /** Agent type (e.g. "general-purpose"). Omit to use the host's fallback. */
  type?: string;
  prompt: string;
  /** Slug-like handle shown in /agents (`@name`). */
  name?: string;
  description?: string;
  /** Canonical `provider/id` — the host resolves strings but knows no aliases. */
  model?: string;
  /** Occupy a maxConcurrent slot and queue behind them. Default true here. */
  isBackground?: boolean;
  maxTurns?: number;
  /** Host-honoured: aborting it stops the subagent (queued or running). */
  signal?: AbortSignal;
}

export type SpawnResult = { ok: true; agentId: string } | { ok: false; error: string };
export type RunResult = { ok: true; text: string } | { ok: false; error: string };

interface RpcEventBus {
  on(event: string, handler: (data: unknown) => void): (() => void) | void;
  emit(event: string, data: unknown): void;
}

function replyText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const PING_TIMEOUT_MS = 250;
const CALL_TIMEOUT_MS = 5000;
/** Spawn waits out agent startup on the host — generous, not the generic cap. */
const SPAWN_TIMEOUT_MS = 120_000;

export class SubagentsRpcClient {
  /** Cached positive readiness; failures retry with a cooldown. */
  private readyOk = false;
  private lastFailedProbe = 0;
  private offReady?: () => void;
  private disposed = false;

  constructor(private readonly events: RpcEventBus) {
    // Host readiness invalidates a cached negative probe.
    this.offReady = this.events.on("subagents:ready", () => {
      this.readyOk = false;
      this.lastFailedProbe = 0;
    }) as (() => void) | undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.offReady?.();
  }

  /** Protocol-version ping. Success is cached; failure retries on a cooldown
   *  and is cleared when the host announces readiness. */
  async ready(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.readyOk) return true;
    if (Date.now() - this.lastFailedProbe < 30_000) return false;
    const ok = await this.ping();
    if (ok) {
      this.readyOk = true;
    } else {
      this.lastFailedProbe = Date.now();
    }
    return ok;
  }

  private ping(): Promise<boolean> {
    const requestId = `sp-ping-${Math.random().toString(36).slice(2)}`;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        off?.();
        clearTimeout(timer);
        resolve(ok);
      };
      const off = this.events.on(`subagents:rpc:ping:reply:${requestId}`, (reply) => {
        const r = reply as { success?: boolean; data?: { version?: number } };
        finish(r?.success === true && r?.data?.version === 2);
      });
      const timer = setTimeout(() => finish(false), PING_TIMEOUT_MS);
      this.events.emit("subagents:rpc:ping", { requestId, version: 2 });
    });
  }

  private call<T>(
    channel: string,
    payload: Record<string, unknown>,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<T> {
    const requestId = `sp-${Math.random().toString(36).slice(2)}`;
    return new Promise<T>((resolve) => {
      let settled = false;
      const off = this.events.on(`${channel}:reply:${requestId}`, (reply) => {
        settled = true;
        off?.();
        clearTimeout(timer);
        resolve(reply as T);
      });
      const timer = setTimeout(() => {
        if (!settled) {
          off?.();
          resolve({ success: false, error: `${channel} timed out after ${timeoutMs}ms` } as T);
        }
      }, timeoutMs);
      this.events.emit(channel, { requestId, ...payload });
    });
  }

  async spawn(
    options: SpawnOptions,
    timeoutMs = SPAWN_TIMEOUT_MS,
  ): Promise<SpawnResult> {
    const reply = await this.call<{ success: boolean; data?: unknown; error?: string }>(
      "subagents:rpc:spawn",
      { type: options.type, prompt: options.prompt, options },
      timeoutMs,
    );
    // The host returns `{ id }` (and only after the agent finished starting
    // up), so accept both a bare id string and the object.
    const raw = reply?.data;
    const agentId =
      typeof raw === "string"
        ? raw
        : raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
          ? (raw as { id: string }).id
          : undefined;
    if (!reply?.success || !agentId) {
      return { ok: false, error: reply?.error ?? "spawn failed: no agent id in reply" };
    }
    return { ok: true, agentId };
  }

  /** Suppress the host's own completion notification for an agent we already
   *  consumed the result of. Synchronous side effect on emit — by design. */
  consume(agentId: string): void {
    void this.call("subagents:rpc:consume", { agentId });
  }

  /** Ask the host to stop an agent we spawned. */
  stop(agentId: string): void {
    void this.call("subagents:rpc:stop", { agentId });
  }

  /**
   * Spawn and wait for the agent's terminal lifecycle event under ONE overall
   * deadline that covers spawn (queue + startup) and execution.
   *
   * Lifecycle listeners are installed BEFORE the spawn request is emitted and
   * early terminal events are buffered until the agent id is known — the host
   * starts execution before its spawn reply, and a very fast agent can
   * otherwise complete before we subscribe (lost event → false timeout).
   *
   * `signal` (e.g. the scheduler's shutdown abort) cancels the wait AND stops
   * the host-side agent via the RPC stop channel.
   */
  async spawnAndWait(
    options: SpawnOptions,
    runTimeoutMs = 30 * 60_000,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    if (signal?.aborted) return { ok: false, error: "aborted before spawn" };

    // One controller to rule the run: deadline or external abort both flow
    // into the host via options.signal and the stop RPC.
    const ctl = new AbortController();
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, runTimeoutMs);
    const onExternalAbort = () => ctl.abort();
    signal?.addEventListener("abort", onExternalAbort, { once: true });
    ctl.signal.addEventListener("abort", () => {
      // best-effort host-side stop + notification suppression once the id is
      // known (consumeResult accepts records abort already marked stopped).
      if (agentId) {
        this.stop(agentId);
        this.consume(agentId);
      }
    });

    let agentId: string | undefined;
    const early: Array<{ e: AgentLifecycleEvent; failed: boolean }> = [];

    return new Promise<RunResult>((resolve) => {
      let done = false;
      const cleanup = () => {
        done = true;
        offCompleted?.();
        offFailed?.();
        clearTimeout(deadline);
        signal?.removeEventListener("abort", onExternalAbort);
      };
      const settle = (result: RunResult) => {
        if (done) return;
        cleanup();
        resolve(result);
      };
      const fromEvent = (e: AgentLifecycleEvent, failed: boolean): RunResult => {
        this.consume(e.id as string);
        // Branch on the channel, never on result emptiness: a failed run can
        // carry partial result text, and a successful run can reply "".
        if (failed) {
          return { ok: false, error: replyText(e.error ?? e.status) || "agent failed" };
        }
        return { ok: true, text: replyText(e.result) };
      };
      const terminal = (e: AgentLifecycleEvent, failed: boolean) => {
        if (!agentId) {
          early.push({ e, failed });
          return;
        }
        if (e?.id !== agentId) return;
        settle(fromEvent(e, failed));
      };
      const offCompleted = this.events.on("subagents:completed", (event) =>
        terminal(event as AgentLifecycleEvent, false),
      );
      const offFailed = this.events.on("subagents:failed", (event) =>
        terminal(event as AgentLifecycleEvent, true),
      );

      const aborted = () =>
        settle({
          ok: false,
          error: timedOut ? `beat timed out after ${runTimeoutMs}ms` : "beat cancelled",
        });
      ctl.signal.addEventListener("abort", aborted, { once: true });

      void (async () => {
        try {
          const spawned = await this.spawn({ ...options, signal: ctl.signal });
          if (!spawned.ok) {
            // Settle first, then abort: the signal we passed in options stops
            // any host agent this timed-out spawn may still have created.
            settle({ ok: false, error: spawned.error });
            ctl.abort();
            return;
          }
          agentId = spawned.agentId;
          // Abort/timeout may have won while the spawn reply was in flight —
          // stop and consume now that the id is known, or the host's later
          // failed-notification fires into a session that stopped waiting.
          if (ctl.signal.aborted) {
            this.stop(agentId);
            this.consume(agentId);
            settle({
              ok: false,
              error: timedOut ? `beat timed out after ${runTimeoutMs}ms` : "beat cancelled",
            });
            return;
          }
          // Reconcile terminal events that fired before the spawn reply.
          const hit = early.find((x) => x.e?.id === agentId);
          if (hit) {
            settle(fromEvent(hit.e, hit.failed));
          }
        } catch (err) {
          settle({ ok: false, error: err instanceof Error ? err.message : String(err) });
          ctl.abort();
        }
      })();
    });
  }
}
