/**
 * Lightweight in-process subagent runner.
 *
 * Used when a scheduled job has `model` set: spawn a fresh AgentSession with
 * the chosen model, run the prompt to completion, return the assistant's text.
 * No subprocess, no extension recursion (noExtensions: true), no persistence.
 */

import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  getAgentDir,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const ABORTED_BEFORE_START = "Subagent aborted before it started";
const DEFAULT_TOOL_NAMES = ["bash", "read", "edit", "write", "grep", "find", "ls"];

export type SubagentResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

export interface RunSubagentOptions {
  /** If true, load all extensions. If an array, only those named. Default undefined (none). */
  extensions?: boolean | string[];
  /** If true, load all skills. If an array, only those named. Default undefined (none). */
  skills?: boolean | string[];
}

const CURRENT_MODEL_ALIASES = new Set(["current", "same", "same-model", "current-model"]);
const FAST_MODEL_ALIASES = new Set(["fast", "fastest", "heartbeat"]);

// Prefer a provider's explicitly advertised fast variant before using a
// heuristic. These IDs are only candidates; auth and availability still come
// from the live model registry. Keep this list minimal: only true budget
// tiers (-flash suffix). Do not add flagship-priced variants here.
const FAST_MODEL_IDS: Record<string, string[]> = {
  "zai-coding-cn": ["glm-5.3-flash"],
  antigravity: ["gemini-3.8-flash"],
  deepseek: ["deepseek-flash"],
};

export function modelReference(model: Model<any>): string {
  return `${model.provider}/${model.id}`;
}

function fastModelScore(model: Model<any>, current: Model<any> | undefined): number {
  const id = `${model.id} ${model.name}`.toLowerCase();
  let score = model.provider === current?.provider ? 100 : 0;
  if (/flash|mini|haiku|nano|small|lite|fast|spark|turbo|air/.test(id)) score += 50;
  // "highspeed" = flagship-priced high-speed reasoning variant, not a cheap tier.
  if (/highspeed|opus|pro|max|ultra|reasoning/.test(id)) score -= 30;
  // Among otherwise similar siblings, prefer the lower API-equivalent cost.
  score -= ((model.cost?.input ?? 0) + (model.cost?.output ?? 0)) * 5;
  if (model.id === current?.id) score -= 1000;
  return score;
}

/** Pick a small model from the current provider, falling back to the current model. */
export function resolveFastModel(
  registry: ExtensionContext["modelRegistry"],
  current: Model<any> | undefined,
): Model<any> | undefined {
  const available = registry.getAvailable();
  const preferred = current ? FAST_MODEL_IDS[current.provider] ?? [] : [];
  for (const id of preferred) {
    // A sibling may be configured but omitted from getAvailable() while the
    // provider's auth check is refreshing. It is safe to reuse the already
    // authenticated current provider for this explicit sibling.
    const exact = current
      ? registry.find(current.provider, id) ??
        available.find((candidate) => candidate.provider === current.provider && candidate.id.toLowerCase() === id)
      : undefined;
    if (exact) return exact;
  }

  const ranked = available
    .filter((candidate) => candidate.id !== current?.id)
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) =>
      fastModelScore(b.candidate, current) - fastModelScore(a.candidate, current) ||
      a.index - b.index,
    );
  return ranked[0]?.candidate ?? current;
}

export function resolveModel(
  registry: ExtensionContext["modelRegistry"],
  modelStr: string,
  currentModel?: Model<any>,
): Model<any> | undefined {
  const normalized = modelStr.trim().toLowerCase();
  if (CURRENT_MODEL_ALIASES.has(normalized)) return currentModel;
  if (FAST_MODEL_ALIASES.has(normalized)) return resolveFastModel(registry, currentModel);

  let fuzzyNeedle = modelStr;
  const slash = modelStr.indexOf("/");
  if (slash !== -1) {
    const provider = modelStr.slice(0, slash);
    const id = modelStr.slice(slash + 1);
    const found = registry.find(provider, id);
    if (found) return found;
    // Slash-form didn't exact-match; fuzzy against the id portion only —
    // matching against "anthropic/haiku" would never find anything since model
    // ids don't include the provider prefix.
    fuzzyNeedle = id;
  }

  const needle = fuzzyNeedle.toLowerCase();
  const candidates = registry.getAvailable();
  return (
    candidates.find((m) => m.id.toLowerCase() === needle) ??
    candidates.find((m) => m.id.toLowerCase().includes(needle)) ??
    candidates.find((m) => m.name.toLowerCase().includes(needle))
  );
}

export function getLastAssistantText(session: AgentSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const parts: string[] = [];
    if (typeof msg.content === "string") {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c && typeof c === "object" && (c as any).type === "text" && (c as any).text) {
          parts.push((c as any).text);
        }
      }
    }
    const text = parts.join("").trim();
    if (text) return text;
  }
  return "";
}

let warnedNoParentRuntime = false;

/**
 * The parent session's ModelRuntime, so the subagent sees the same providers
 * (including ones registered by other extensions) and runtime API keys.
 *
 * pi >=0.80.8 replaced `createAgentSession({ modelRegistry })` with
 * `modelRuntime` and exposes no public accessor for it. `ModelRegistry` wraps
 * the session's runtime in a field that is private only in the TypeScript
 * types (`new ModelRegistry(this._modelRuntime)` in pi's AgentSession), so we
 * read it there. Returns undefined (and warns once) if pi ever renames the
 * field, in which case pi builds a fresh default runtime for the subagent.
 */
export function parentModelRuntime(ctx: ExtensionContext): ModelRuntime | undefined {
  const rt = (ctx.modelRegistry as unknown as { runtime?: Partial<ModelRuntime> }).runtime;
  const looksLikeRuntime =
    typeof rt?.getAuth === "function" &&
    typeof rt.getModel === "function" &&
    typeof rt.hasConfiguredAuth === "function" &&
    typeof rt.registerProvider === "function";
  if (looksLikeRuntime) return rt as ModelRuntime;
  if (!warnedNoParentRuntime) {
    warnedNoParentRuntime = true;
    console.warn(
      "[pi-schedule-prompt] Could not reach the parent session's model runtime; subagent jobs " +
        "fall back to pi's default runtime (auth.json/models.json). Providers registered by " +
        "other extensions and runtime-only API keys will be unavailable to subagents.",
    );
  }
  return undefined;
}

/** Upper bound for each teardown step, so a hung abort or extension shutdown can't wedge the job. */
const TEARDOWN_STEP_TIMEOUT_MS = 5_000;

/** Resolve when `p` settles or after `ms`, whichever comes first. Never rejects. */
async function settleWithin(p: Promise<unknown>, ms: number, what: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    const outcome = await Promise.race([p.then(() => "ok" as const), timeout]);
    if (outcome === "timeout") {
      console.warn(`[pi-schedule-prompt] Subagent ${what} did not finish within ${ms}ms; continuing teardown.`);
    }
  } catch (err) {
    console.warn(`[pi-schedule-prompt] Subagent ${what} failed:`, err);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tear a finished subagent session down the way pi tears down its own
 * sessions (AgentSessionRuntime.teardownCurrent): settle any in-flight run,
 * let loaded extensions run their `session_shutdown` handlers (MCP servers,
 * child processes, timers), then dispose. `dispose()` alone does not emit
 * `session_shutdown`. The shutdown emit mirrors pi's internal
 * `emitSessionShutdownEvent` (hasHandlers + emit), which pi does not export.
 * Each awaited step is time-bounded and the function never throws, so a
 * successful run's result is always returned.
 */
async function teardownSubagentSession(
  session: AgentSession,
  extensionsLoaded: boolean,
): Promise<void> {
  await settleWithin(session.abort(), TEARDOWN_STEP_TIMEOUT_MS, "abort");
  if (extensionsLoaded) {
    try {
      const runner = session.extensionRunner;
      if (runner.hasHandlers("session_shutdown")) {
        await settleWithin(
          runner.emit({ type: "session_shutdown", reason: "quit" }),
          TEARDOWN_STEP_TIMEOUT_MS,
          "extension shutdown",
        );
      }
    } catch (err) {
      console.warn("[pi-schedule-prompt] Subagent extension shutdown failed:", err);
    }
  }
  try {
    session.dispose();
  } catch (err) {
    console.warn("[pi-schedule-prompt] Subagent session dispose failed:", err);
  }
}

export function describeAvailableModels(
  registry: ExtensionContext["modelRegistry"],
): string {
  const available = registry.getAvailable();
  if (available.length === 0) return "No models with configured auth.";
  const sample = available.slice(0, 5).map((m) => `${m.provider}/${m.id}`).join(", ");
  const more = available.length > 5 ? `, … (${available.length - 5} more)` : "";
  return `Available: ${sample}${more}`;
}

/**
 * A live subagent AgentSession plus the model metadata it was created with.
 * Intended for reuse across prompts (resident session): create once with
 * createSubagentSession, then drive each beat with promptSubagentSession.
 */
export interface SubagentHandle {
  session: AgentSession;
  model: Model<any>;
  /** Canonical `provider/id` reference of the resolved model. */
  modelRef: string;
  /** The raw model string the caller requested (pre-resolution). */
  requestedModel: string;
}

/**
 * Resolve the requested model and spin up a fresh AgentSession for it
 * (resource loader, session creation, extension binding). Does not prompt.
 * Returns the live handle on success or an error string on failure. An
 * already-aborted `signal` (checked between setup steps) yields
 * ABORTED_BEFORE_START so an aborted job never starts prompting.
 */
export async function createSubagentSession(
  ctx: ExtensionContext,
  modelStr: string,
  currentModel: Model<any> | undefined,
  options: RunSubagentOptions,
  signal?: AbortSignal,
): Promise<{ ok: true; handle: SubagentHandle } | { ok: false; error: string }> {
  // Hoisted so a failure AFTER the session exists can tear it down (bounded
  // abort → conditional session_shutdown → dispose) instead of leaking it.
  let created: AgentSession | undefined;
  let extensionsBound = false;
  try {
    const model = resolveModel(ctx.modelRegistry, modelStr, currentModel);
    if (!model) {
      return {
        ok: false,
        error: `Unknown model '${modelStr}'. ${describeAvailableModels(ctx.modelRegistry)}`,
      };
    }

    const agentDir = getAgentDir();

    // Helper: convert extensions/skills option to a name list (undefined = all).
    const getNameList = (v: boolean | string[] | undefined): string[] | undefined =>
      Array.isArray(v) && v.length > 0 ? v : undefined;

    const extList = getNameList(options.extensions);
    const skillList = getNameList(options.skills);

    const loader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      // Prevent recursive loading of this extension into the subagent.
      // Context files (AGENTS.md / CLAUDE.md) are loaded by defaults.
      noExtensions: !isEnabled(options.extensions),
      noSkills: !isEnabled(options.skills),
      noPromptTemplates: true,
      noThemes: true,
      ...(extList && {
        extensionsOverride: (base) => ({
          ...base,
          extensions: base.extensions.filter((ext) =>
            extList.some((name) => ext.path.toLowerCase().includes(name.toLowerCase())),
          ),
        }),
      }),
      ...(skillList && {
        skillsOverride: (base) => ({
          ...base,
          skills: base.skills.filter((skill) =>
            skillList.includes(skill.name || ""),
          ),
        }),
      }),
    });
    // Skip setup once aborted (e.g. scheduler stopped mid-setup): aborting an
    // idle session records nothing, so prompt() would otherwise still run.
    if (signal?.aborted) return { ok: false, error: ABORTED_BEFORE_START };
    await loader.reload();
    if (signal?.aborted) return { ok: false, error: ABORTED_BEFORE_START };

    const { session } = await createAgentSession({
      cwd: ctx.cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(ctx.cwd),
      settingsManager: SettingsManager.create(ctx.cwd, agentDir),
      // Share the parent's runtime only when the subagent loads no extensions:
      // extension provider (un)registrations write into whatever runtime the
      // session holds, so a shared one would let subagent extensions rewrite
      // the parent's providers. With extensions loaded, the subagent gets pi's
      // default runtime and its extensions register their own providers.
      // undefined → pi builds its default runtime from agentDir's auth.json/models.json.
      modelRuntime: isEnabled(options.extensions) ? undefined : parentModelRuntime(ctx),
      model,
      tools: isEnabled(options.extensions) ? undefined : DEFAULT_TOOL_NAMES,
      resourceLoader: loader,
    });
    created = session;

    // Checked before bindExtensions so an aborted job doesn't start (and then
    // shut down) its extensions — mirroring the loader checks above.
    if (signal?.aborted) {
      await teardownSubagentSession(session, false);
      return { ok: false, error: ABORTED_BEFORE_START };
    }

    // Track whether extensions may have received session_start (and so need
    // session_shutdown on a failure path after this point). Set BEFORE
    // awaiting bindExtensions: it delivers session_start first and can still
    // throw afterwards (resource discovery, system prompt rebuild).
    if (isEnabled(options.extensions)) {
      extensionsBound = true;
      await session.bindExtensions({});
    }

    return {
      ok: true,
      handle: {
        session,
        model,
        modelRef: modelReference(model),
        requestedModel: modelStr,
      },
    };
  } catch (err) {
    if (created) {
      await teardownSubagentSession(created, extensionsBound);
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Abort a session, tolerating both Promise-returning and void `abort()`. */
function abortSession(session: AgentSession): void {
  try {
    Promise.resolve(session.abort()).catch(() => {});
  } catch {
    // best-effort
  }
}

/** Whether an extensions/skills option selects anything. */
function isEnabled(v: boolean | string[] | undefined): boolean {
  return v === true || (Array.isArray(v) && v.length > 0);
}

/**
 * Run one prompt to completion on an (existing) AgentSession and return only
 * the text streamed during THIS invocation. Resident-session contract: an
 * empty reply yields {ok:true, text:""} — never a previous beat's answer from
 * session history. An abort mid-run yields {ok:false} instead of partial text.
 */
export async function promptSubagentSession(
  session: AgentSession,
  prompt: string,
  signal?: AbortSignal,
): Promise<SubagentResult> {
  // An already-aborted signal must NOT start a prompt — aborting an idle
  // session and prompting anyway resurrects work the caller cancelled.
  if (signal?.aborted) {
    abortSession(session);
    return { ok: false, error: ABORTED_BEFORE_START };
  }
  let onAbort: (() => void) | undefined;
  if (signal) {
    onAbort = () => abortSession(session);
    signal.addEventListener("abort", onAbort, { once: true });
  }

  let buffered = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") {
      buffered = "";
    } else if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      buffered += event.assistantMessageEvent.delta;
    }
  });

  try {
    await session.prompt(prompt, {
      // An abort during prompt preflight (input hooks, auth check) is lost:
      // pi clears the abort flag when the run starts. Re-apply it then.
      preflightResult: (disposition) => {
        if (disposition === "started" && signal?.aborted) {
          abortSession(session);
        }
      },
    });
    // An abort mid-run makes prompt() resolve normally with partial text.
    if (signal?.aborted) return { ok: false, error: "Subagent aborted" };
  } finally {
    unsubscribe();
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }

  return { ok: true, text: buffered.trim() };
}

export async function runSubagentOnce(
  ctx: ExtensionContext,
  prompt: string,
  modelStr: string,
  signal?: AbortSignal,
  options: RunSubagentOptions = {},
): Promise<SubagentResult> {
  const created = await createSubagentSession(ctx, modelStr, ctx.model, options, signal);
  if (!created.ok) {
    return { ok: false, error: created.error };
  }

  // Bounded teardown no matter how the run ends: settle any in-flight run,
  // let loaded extensions run session_shutdown, then dispose. Never throws,
  // so the run's result survives teardown failures.
  const { session } = created.handle;
  try {
    const result = await promptSubagentSession(session, prompt, signal);
    if (result.ok) {
      // One-shot salvage: if this invocation streamed nothing (no text
      // deltas), fall back to the session's last assistant message.
      return { ok: true, text: result.text || getLastAssistantText(session) };
    }
    return result;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await teardownSubagentSession(session, isEnabled(options.extensions));
  }
}
