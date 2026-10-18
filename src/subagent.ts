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
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

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
 * Returns the live handle on success or an error string on failure.
 */
export async function createSubagentSession(
  ctx: ExtensionContext,
  modelStr: string,
  currentModel: Model<any> | undefined,
  options: RunSubagentOptions,
): Promise<{ ok: true; handle: SubagentHandle } | { ok: false; error: string }> {
  try {
    const model = resolveModel(ctx.modelRegistry, modelStr, currentModel);
    if (!model) {
      return {
        ok: false,
        error: `Unknown model '${modelStr}'. ${describeAvailableModels(ctx.modelRegistry)}`,
      };
    }

    const agentDir = getAgentDir();

    // Helper: convert extensions/skills option to boolean and optionally filter.
    // An empty array means "none" — same as unset.
    const isEnabled = (v: boolean | string[] | undefined): boolean =>
      v === true || (Array.isArray(v) && v.length > 0);
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
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: ctx.cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(ctx.cwd),
      settingsManager: SettingsManager.create(ctx.cwd, agentDir),
      model,
      tools: isEnabled(options.extensions) ? undefined : DEFAULT_TOOL_NAMES,
      resourceLoader: loader,
    });

    if (isEnabled(options.extensions)) {
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
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run one prompt to completion on an (existing) AgentSession and return only
 * the text streamed during THIS invocation. Resident-session contract: an
 * empty reply yields {ok:true, text:""} — never a previous beat's answer from
 * session history. Errors from session.prompt propagate to the caller.
 */
export async function promptSubagentSession(
  session: AgentSession,
  prompt: string,
  signal?: AbortSignal,
): Promise<SubagentResult> {
  let onAbort: (() => void) | undefined;
  if (signal) {
    if (signal.aborted) {
      session.abort();
    } else {
      onAbort = () => session.abort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
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
    await session.prompt(prompt);
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
  try {
    const created = await createSubagentSession(ctx, modelStr, ctx.model, options);
    if (!created.ok) {
      return { ok: false, error: created.error };
    }

    const { session } = created.handle;
    const result = await promptSubagentSession(session, prompt, signal);
    if (result.ok) {
      // One-shot salvage: if this invocation streamed nothing (no text
      // deltas), fall back to the session's last assistant message.
      return { ok: true, text: result.text || getLastAssistantText(session) };
    }
    return result;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
