// Minimal client for pi-subagents' cross-extension RPC (docs/rpc.md, protocol
// v2). All calls are in-process pi.events emit/on round-trips — no imports of
// the pi-subagents package, so this degrades gracefully when it is absent.
//
// Used by the scheduler as the default subagent runner: beats spawned this way
// are visible and steerable in the user's existing /agents conversation views.

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
  /** "provider/modelId" string, resolved by the host. */
  model?: string;
  /** Occupy a maxConcurrent slot and queue behind them. Default true here. */
  isBackground?: boolean;
  maxTurns?: number;
}

export type SpawnResult = { ok: true; agentId: string } | { ok: false; error: string };
export type RunResult = { ok: true; text: string } | { ok: false; error: string };

interface RpcEventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
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

export class SubagentsRpcClient {
  private readyPromise: Promise<boolean> | undefined;

  constructor(
    private readonly events: RpcEventBus,
    private readonly timeoutMs = 5000,
  ) {}

  /** Async protocol-version ping; the result is cached after the first call.
   *  Host handlers reply on a microtask (their wrapper is async), so a
   *  synchronous probe would always miss — see pi-subagents rpc.md. */
  ready(): Promise<boolean> {
    this.readyPromise ??= new Promise<boolean>((resolve) => {
      const requestId = `sp-ping-${Math.random().toString(36).slice(2)}`;
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        off?.();
        clearTimeout(timer);
        resolve(ok);
      };
      const off = this.events.on(`subagents:rpc:ping:reply:${requestId}`, (reply) => {
        finish(Boolean((reply as { success?: boolean })?.success));
      });
      const timer = setTimeout(() => finish(false), 250);
      this.events.emit("subagents:rpc:ping", { requestId, version: 2 });
    });
    return this.readyPromise;
  }

  private call<T>(channel: string, payload: Record<string, unknown>): Promise<T> {
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
          resolve({ success: false, error: `${channel} timed out after ${this.timeoutMs}ms` } as T);
        }
      }, this.timeoutMs);
      this.events.emit(channel, { requestId, ...payload });
    });
  }

  async spawn(options: SpawnOptions): Promise<SpawnResult> {
    const reply = await this.call<{ success: boolean; data?: string; error?: string }>(
      "subagents:rpc:spawn",
      { type: options.type, prompt: options.prompt, options },
    );
    if (!reply?.success || !reply.data) {
      return { ok: false, error: reply?.error ?? "spawn failed" };
    }
    return { ok: true, agentId: reply.data };
  }

  /** Suppress the host's own completion notification for an agent we already
   *  consumed the result of. Fire-and-forget by design. */
  consume(agentId: string): void {
    void this.call("subagents:rpc:consume", { agentId });
  }

  /** Spawn and wait for the agent's terminal lifecycle event. */
  async spawnAndWait(options: SpawnOptions, runTimeoutMs = 30 * 60_000): Promise<RunResult> {
    const spawned = await this.spawn(options);
    if (!spawned.ok) return spawned;
    const agentId = spawned.agentId;

    return new Promise<RunResult>((resolve) => {
      let cleanup: () => void = () => {};
      const finish = (result: RunResult) => {
        cleanup();
        resolve(result);
      };
      const offCompleted = this.events.on("subagents:completed", (event) => {
        const e = event as AgentLifecycleEvent;
        if (e?.id !== agentId) return;
        this.consume(agentId);
        finish({ ok: true, text: replyText(e.result) });
      });
      const offFailed = this.events.on("subagents:failed", (event) => {
        const e = event as AgentLifecycleEvent;
        if (e?.id !== agentId) return;
        this.consume(agentId);
        finish({ ok: false, error: replyText(e.error ?? e.status ?? "agent failed") || "agent failed" });
      });
      const timer = setTimeout(() => {
        finish({ ok: false, error: `heartbeat beat timed out after ${runTimeoutMs}ms` });
      }, runTimeoutMs);
      cleanup = () => {
        offCompleted();
        offFailed();
        clearTimeout(timer);
      };
    });
  }
}
