import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Cron } from "croner";
import * as path from "path";
import { archiveRun, readRuns } from "./run-log.js";
import type { CronStorage } from "./storage.js";
import {
  createSubagentSession,
  describeAvailableModels,
  modelReference,
  promptSubagentSession,
  resolveModel,
  runSubagentOnce,
  type SubagentHandle,
  type SubagentResult,
} from "./subagent.js";
import { SubagentsRpcClient } from "./subagents-rpc.js";
import type { CronChangeEvent, CronJob, CronJobType } from "./types.js";

/** Result of `CronScheduler.validateSchedule`. On success, `schedule` is the
 *  resolved form to persist (ISO for `once`, original for `cron`/`interval`). */
type ValidateScheduleResult =
  | { ok: true; schedule: string; intervalMs?: number }
  | { ok: false; error: string };

const SUBAGENT_OUTPUT_SNIPPET_LENGTH = 500;

/** Truncate `text` to `SUBAGENT_OUTPUT_SNIPPET_LENGTH`, appending an ellipsis if cut. */
function snippet(text: string): string {
  return text.length > SUBAGENT_OUTPUT_SNIPPET_LENGTH
    ? text.slice(0, SUBAGENT_OUTPUT_SNIPPET_LENGTH) + "…"
    : text;
}

// Negation-guarded: prose like "no ERROR observed" or "did not fail" must not
// count as an anomaly — only affirmative mentions do.
const ANOMALY_OUTPUT =
  /(?<!\bno\s+)(?<!\bnot\s+)(?<!\bwithout\s+)(?<!\bnever\s+)\b(?:HEARTBEAT_ALERT|ALERT|CRITICAL|ERROR|FAILED|OOM|DEAD|UNREACHABLE|BLOCKED)\b/i;

/** Escape a literal string for embedding in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shouldNotify(job: CronJob, output: string, failed: boolean): boolean {
  if (job.notifyOn === "never") return false;
  if (job.notifyOn === "always") return true;
  if (job.notifyOn === "anomaly") return failed || isAnomalyOutput(output);
  // Keep the pre-0.5 boolean behavior for existing jobs.
  return job.notify === true;
}

/** True when the output looks anomalous — shared by the wake and display gates. */
function isAnomalyOutput(output: string): boolean {
  return ANOMALY_OUTPUT.test(output);
}

/** Whether a run marker is *rendered* in the parent chat. Orthogonal to
 *  `shouldNotify` (wake): a marker is sent when either gate is open, and a
 *  fully quiet run (both gates closed) sends nothing at all — zero chat
 *  rows, zero parent-context growth. Classification always uses the full
 *  untruncated output so an ALERT past the snippet boundary still counts. */
function shouldDisplay(job: CronJob, output: string, failed: boolean): boolean {
  if (job.displayOn === "never") return false;
  if (job.displayOn === "anomaly") return failed || isAnomalyOutput(output);
  // Undefined/`always` keeps the historical marker behavior for existing jobs.
  return true;
}

/** Cap for a persisted STATUS: progress line. */
const STATUS_LINE_MAX = 240;
/** Transcript size (chars) at which a resident session resets with a handoff. */
const RESIDENT_RESET_CHARS = 120_000;
/** Hard wall-clock cap for a single beat run through any runner. */
const BEAT_TIMEOUT_MS = 30 * 60_000;
/** With notifyOn=anomaly, a persistent anomaly re-wakes only every Nth beat. */
const ALERT_REWAKE_EVERY = 4;
/** Suffix appended to subagent beat prompts so progress is machine-readable. */
const STATUS_CONVENTION =
  "\n\n(Output convention: make the FIRST line of your reply exactly `STATUS: <one-line plain-text progress summary, max 120 chars, no markdown>`; put all details after that line.)";

/** Remove ANSI CSI/OSC sequences and C0 control chars from a status line. */
function stripTerminalCodes(s: string): string {
  return s
    .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1B\][^\x07\x1B]*(\x07|\x1B\\)?/g, "")
    .replace(/[\x00-\x1F\x7F]/g, "");
}

/**
 * Extract the `STATUS:` progress line. Only the FIRST non-empty output line
 * is eligible — a `STATUS:` quoted deeper in the output is not a progress
 * report. Returns undefined when absent; sanitized and length-capped.
 */
function extractStatusLine(rawOutput: string): string | undefined {
  for (const line of rawOutput.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^STATUS:\s*(.*)$/);
    if (!m) return undefined;
    const cleaned = stripTerminalCodes(m[1]).trim();
    return cleaned ? cleaned.slice(0, STATUS_LINE_MAX) : undefined;
  }
  return undefined;
}

/** Bounded text-only digest of the parent session's active branch, used to
 *  seed a resident subagent with main-agent context. Tool payloads, thinking
 *  and non-message entries are skipped; each message is capped. */
function buildParentDigest(entries: unknown[], maxChars = 8000): string {
  const parts: string[] = [];
  let total = 0;
  for (const e of entries) {
    const entry = e as { type?: string; message?: { role?: string; content?: unknown } };
    if (entry?.type !== "message" || !entry.message) continue;
    const role = entry.message.role ?? "user";
    // Text dialogue only — tool payloads and system boilerplate would bloat
    // the seed and leak unrelated content into the child session.
    if (role === "system" || role === "toolResult") continue;
    let text = "";
    const content = entry.message.content;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .map((c) =>
          c && typeof c === "object" && (c as { type?: string }).type === "text"
            ? String((c as { text?: string }).text ?? "")
            : "",
        )
        .join(" ");
    }
    text = stripTerminalCodes(text).trim();
    if (!text) continue;
    const chunk = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    if (total + chunk.length > maxChars) break;
    parts.push(`${role}: ${chunk}`);
    total += chunk.length;
  }
  return parts.join("\n");
}

/** Live state for a job's resident subagent session. */
interface ResidentRecord {
  handle: SubagentHandle;
  beats: number;
  estChars: number;
  createdAt: number;
}

/**
 * Manages cron job scheduling and execution
 */
export class CronScheduler {
  private jobs = new Map<string, Cron>();
  private intervals = new Map<string, NodeJS.Timeout>();
  private activeSubagents = new Set<AbortController>();
  private activeJobs = new Set<string>();
  private readonly storage: CronStorage;
  private readonly pi: ExtensionAPI;
  private readonly ctx: ExtensionContext;
  private currentModel: ExtensionContext["model"];
  private readonly logBaseDir: string;
  /** Live resident sessions for jobs with resident=true. */
  private residentSessions = new Map<string, ResidentRecord>();
  /** Handoff summaries carried across resident resets (memory-bounded). */
  private residentHandoffs = new Map<string, string>();
  /** Default subagent runner: pi-subagents' cross-extension RPC, when present. */
  private readonly subagentsRpc: SubagentsRpcClient;

  constructor(storage: CronStorage, pi: ExtensionAPI, ctx: ExtensionContext, logBaseDir?: string) {
    this.storage = storage;
    this.pi = pi;
    this.ctx = ctx;
    this.currentModel = ctx.model;
    // Overridable for tests; defaults into the plugin-owned agent dir so
    // quiet-run archives never land inside the user's project tree.
    this.logBaseDir = logBaseDir ?? path.join(getAgentDir(), "schedule-logs");
    this.subagentsRpc = new SubagentsRpcClient(pi.events);
  }

  /** Base directory of the per-job run archive (see run-log.ts). */
  getRunLogBaseDir(): string {
    return this.logBaseDir;
  }

  /** Keep dynamic model aliases aligned with `/model` changes in the parent session. */
  setCurrentModel(model: ExtensionContext["model"]): void {
    this.currentModel = model;
  }

  /**
   * Schedule all enabled jobs loaded for this session — see `isLoadedFor`.
   * Foreign-session jobs are skipped so two pis in the same cwd don't double-fire.
   *
   * Also clears stale `lastStatus: "running"` from an interrupted prior run of
   * *this* session (process kill, abort) — otherwise the widget sticks on `⟳`
   * until the cron next fires. Other sessions' flags are theirs to manage.
   */
  start(): void {
    const mySessionId = this.ctx.sessionManager.getSessionId();
    for (const job of this.storage.getAllJobs()) {
      if (!CronScheduler.isLoadedFor(job, mySessionId)) continue;
      if (job.lastStatus === "running") {
        this.storage.updateJob(job.id, { lastStatus: undefined });
      }
      if (job.enabled) {
        this.scheduleJob(job);
      }
    }
  }

  /** Unbound jobs (no `session` field) load for everyone. */
  static isLoadedFor(job: CronJob, sessionId: string | undefined): boolean {
    return !job.session || job.session === sessionId;
  }

  /**
   * Stop all scheduled jobs
   */
  stop(): void {
    // Abort any in-flight subagent runs so they don't keep streaming or post
    // markers against a stale pi reference after session shutdown.
    for (const controller of this.activeSubagents) {
      controller.abort();
    }
    this.activeSubagents.clear();
    this.activeJobs.clear();

    // Resident sessions outlive individual beats — dispose them explicitly.
    for (const jobId of [...this.residentSessions.keys()]) {
      this.disposeResident(jobId);
    }
    this.residentHandoffs.clear();
    this.subagentsRpc.dispose();

    // Stop all cron jobs
    for (const cron of this.jobs.values()) {
      cron.stop();
    }
    this.jobs.clear();

    // Clear all intervals
    for (const interval of this.intervals.values()) {
      clearInterval(interval);
    }
    this.intervals.clear();
  }

  /**
   * Add and schedule a new job
   */
  addJob(job: CronJob): void {
    if (job.enabled) {
      this.scheduleJob(job);
    }
    this.emitChange({ type: "add", job });
  }

  /**
   * Remove and unschedule a job
   */
  removeJob(id: string): void {
    this.disposeResident(id);
    this.residentHandoffs.delete(id);
    this.unscheduleJob(id);
    this.emitChange({ type: "remove", jobId: id });
  }

  /**
   * Update a job (reschedule if needed)
   */
  updateJob(id: string, updated: CronJob): void {
    // Configuration changes invalidate a resident session's memory — dispose
    // so the next beat starts fresh (with a handoff) under the new config.
    const previous = this.storage.getJob(id);
    if (
      previous &&
      (previous.model !== updated.model ||
        previous.prompt !== updated.prompt ||
        previous.resident !== updated.resident ||
        previous.contextNote !== updated.contextNote ||
        JSON.stringify(previous.extensions) !== JSON.stringify(updated.extensions) ||
        JSON.stringify(previous.skills) !== JSON.stringify(updated.skills))
    ) {
      this.disposeResident(id);
    }
    this.unscheduleJob(id);
    if (updated.enabled) {
      this.scheduleJob(updated);
    }
    this.emitChange({ type: "update", job: updated });
  }

  /**
   * Get next run time for a job
   */
  getNextRun(jobId: string): Date | null {
    const cron = this.jobs.get(jobId);
    if (cron) {
      const next = cron.nextRun();
      return next || null;
    }
    return null;
  }

  /**
   * Schedule a single job
   */
  private scheduleJob(job: CronJob): void {
    try {
      if (job.type === "interval" && job.intervalMs) {
        // Interval-based scheduling
        const interval = setInterval(() => {
          this.executeJob(job);
        }, job.intervalMs);
        this.intervals.set(job.id, interval);
      } else if (job.type === "once") {
        // One-shot execution at a specific time
        const targetDate = new Date(job.schedule);
        const now = new Date();
        const delay = targetDate.getTime() - now.getTime();

        if (delay > 0) {
          const timeout = setTimeout(() => {
            this.executeJob(job);
            // Auto-disable one-shot jobs after execution
            this.storage.updateJob(job.id, { enabled: false });
            this.emitChange({ type: "update", job: { ...job, enabled: false } });
          }, delay);
          // Store as interval for cleanup purposes
          this.intervals.set(job.id, timeout as any);
        } else {
          // Job is in the past - disable it and log warning
          console.warn(`Job ${job.id} (${job.name}) scheduled for past time: ${job.schedule}`);
          this.storage.updateJob(job.id, { 
            enabled: false,
            lastStatus: "error" 
          });
          this.emitChange({ 
            type: "error", 
            jobId: job.id, 
            error: `Scheduled time ${job.schedule} is in the past` 
          });
        }
      } else {
        // Standard cron expression
        const cron = new Cron(job.schedule, () => {
          this.executeJob(job);
        });
        this.jobs.set(job.id, cron);
      }
    } catch (error) {
      console.error(`Failed to schedule job ${job.id}:`, error);
      this.emitChange({
        type: "error",
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Unschedule a job
   */
  private unscheduleJob(id: string): void {
    const cron = this.jobs.get(id);
    if (cron) {
      cron.stop();
      this.jobs.delete(id);
    }

    const interval = this.intervals.get(id);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(id);
    }
  }

  /**
   * Execute a job's prompt
   */
  private async executeJob(job: CronJob): Promise<void> {
    // Re-read before firing — closure-captured `job` is stale if storage was
    // edited mid-tick (removed, disabled, or `session` rebound by hand-edit).
    const fresh = this.storage.getJob(job.id);
    if (!fresh?.enabled) return;
    if (!CronScheduler.isLoadedFor(fresh, this.ctx.sessionManager.getSessionId())) return;

    if (!fresh.model) {
      console.log(`Executing scheduled prompt: ${fresh.name} (${fresh.id})`);
    }

    if (fresh.model) {
      // A slow health check must not overlap with the next interval. Overlap
      // was a major source of duplicate diagnostics and quota consumption.
      if (this.activeJobs.has(fresh.id)) return;
      this.activeJobs.add(fresh.id);
      void this.executeJobInSubagent(fresh)
        .catch((error) => console.error(`Scheduled subagent job ${fresh.id} failed:`, error))
        .finally(() => this.activeJobs.delete(fresh.id));
      return;
    }

    try {
      // Update status to running
      this.storage.updateJob(job.id, {
        lastStatus: "running",
      });
      this.emitChange({ type: "fire", job });

      // Visible-only marker. The renderer reads from `details`, so `content`
      // is intentionally empty — putting the prompt text in `content` would
      // inject it into the LLM context a second time alongside the
      // `sendUserMessage` delivery below, producing duplicate turns /
      // "PROMPT\n\nPROMPT" rendering when the agent was streaming at fire
      // time. No options means: idle → silent append + emit (marker shows
      // before the user message in the chat), streaming → `agent.steer` with
      // empty content (no LLM context change, no extra turn triggered).
      this.pi.sendMessage({
        customType: "scheduled_prompt",
        content: [],
        display: true,
        details: { jobId: job.id, jobName: job.name, prompt: job.prompt },
      });

      // Then send the actual prompt to the agent — this is the single LLM-visible delivery.
      this.pi.sendUserMessage(job.prompt, { deliverAs: "followUp" });

      // Update job execution stats.
      //
      // `job` here is captured by the croner closure in `scheduleJob` and is
      // therefore frozen at the value it had when the scheduler was created —
      // reading `job.runCount` yields a stale count, so incrementing it writes
      // the same value to storage on every fire and the counter never advances.
      // Re-read from storage to get the latest known count.
      const nextRun = this.getNextRun(job.id);
      const latest = this.storage.getJob(job.id);
      const currentRunCount = latest?.runCount ?? job.runCount;
      this.storage.updateJob(job.id, {
        lastRun: new Date().toISOString(),
        lastStatus: "success",
        runCount: currentRunCount + 1,
        nextRun: nextRun?.toISOString(),
      });

      this.emitChange({ type: "fire", job });
    } catch (error) {
      console.error(`Failed to execute job ${job.id}:`, error);
      this.storage.updateJob(job.id, {
        lastRun: new Date().toISOString(),
        lastStatus: "error",
      });
      this.emitChange({
        type: "error",
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Short rolling memory block from the run archive — gives stateless
   *  per-beat subagents (pi-subagents runner) their trend context. */
  private recentBeatsMemory(job: CronJob): string {
    const runs = readRuns(this.logBaseDir, this.ctx.cwd, job.id, 5);
    if (runs.length === 0) return "";
    const blocks = runs.map((r) => {
      const body = (r.output ?? r.error ?? "").slice(0, 800);
      return `[${r.ts}] ${r.outcome}${r.kind && r.kind !== "beat" ? ` (${r.kind})` : ""}:\n${body}`;
    });
    return `\n\nRecent beats from this job's archive (newest first) — use as your trend memory:\n${blocks.join("\n---\n")}`;
  }

  /** Drop a job's resident session (config change, removal, shutdown). */
  private disposeResident(jobId: string): void {
    const record = this.residentSessions.get(jobId);
    if (!record) return;
    this.residentSessions.delete(jobId);
    try {
      record.handle.session.abort();
    } catch (error) {
      console.warn(`[pi-schedule-prompt] failed to abort resident session for ${jobId}:`, error);
    }
  }

  /** Build the seed prompt for a fresh resident session. Seeding happens via
   *  the first beat prompt (no extra model turn is spent on the seed). */
  private buildResidentSeed(job: CronJob, handoff?: string): string {
    const lines: string[] = [
      "You are a persistent background heartbeat agent. You are re-invoked on a schedule; each message is one beat. Remember earlier beats and report trends (memory, GPU, stage progress, error counts) — you are the memory of this experiment run.",
    ];
    if (job.contextNote) {
      lines.push(`\nBackground you should always keep in mind:\n${job.contextNote.slice(0, 4000)}`);
    }
    let entries: unknown[] = [];
    try {
      entries = this.ctx.sessionManager.getEntries?.() ?? [];
    } catch {
      // digest is best-effort
    }
    const digest = buildParentDigest(entries);
    if (digest) {
      lines.push(
        `\nParent session digest (bounded, text-only, for main-agent context):\n${digest}`,
      );
    }
    if (handoff) {
      lines.push(`\nHandoff from your previous session:\n${handoff}`);
    }
    return lines.join("\n");
  }

  /** Get or create the resident session for a job. The model is resolved and
   *  pinned at creation; later main-model changes affect only new sessions. */
  private async getOrCreateResident(
    job: CronJob,
  ): Promise<
    { ok: true; record: ResidentRecord; seed?: string } | { ok: false; error: string }
  > {
    const existing = this.residentSessions.get(job.id);
    if (existing) return { ok: true, record: existing };

    const created = await createSubagentSession(this.ctx, job.model!, this.currentModel, {
      extensions: job.extensions,
      skills: job.skills,
    });
    if (!created.ok) return created;

    const handoff = this.residentHandoffs.get(job.id);
    this.residentHandoffs.delete(job.id);
    const seed = this.buildResidentSeed(job, handoff);
    const record: ResidentRecord = {
      handle: created.handle,
      beats: 0,
      estChars: seed.length,
      createdAt: Date.now(),
    };
    this.residentSessions.set(job.id, record);
    return { ok: true, record, seed };
  }

  /** Reset a resident session once its transcript outgrows the bound or its
   *  TTL expires — whichever comes first — carrying a handoff summary into
   *  the fresh session on the next beat. Bounds both memory drift and token
   *  spend: a slow heartbeat cannot accumulate weeks of stale context. */
  private maybeResetResident(job: CronJob, lastOutput: string): void {
    const record = this.residentSessions.get(job.id);
    if (!record) return;
    const ttlMinutes = job.residentTtlMinutes ?? 60;
    const ttlExpired = ttlMinutes > 0 && Date.now() - record.createdAt > ttlMinutes * 60_000;
    if (!ttlExpired && record.estChars <= RESIDENT_RESET_CHARS) return;
    const handoff = [
      `Beats completed in your previous session: ${record.beats}.`,
      `Reset reason: ${ttlExpired ? `session age exceeded ${ttlMinutes} minutes` : "transcript size bound reached"}.`,
      job.lastStatusLine ? `Last status line: ${job.lastStatusLine}` : "",
      `Last beat output (truncated):\n${lastOutput.slice(0, 2000)}`,
      "Carry forward any open anomalies and baselines from your memory; re-summarize them in your next reply if still relevant.",
    ]
      .filter(Boolean)
      .join("\n");
    this.residentHandoffs.set(job.id, handoff);
    this.disposeResident(job.id);
    console.log(
      `[pi-schedule-prompt] resident session for job ${job.id} reset (${ttlExpired ? `ttl ${ttlMinutes}m` : `transcript bound ${RESIDENT_RESET_CHARS} chars`})`,
    );
  }

  /** Ad-hoc question into a job's resident session — the dialogue channel for
   *  the main agent. Inspection-only: no counters, no stopOn, no wake logic. */
  async askResident(jobId: string, question: string): Promise<SubagentResult> {
    const job = this.storage.getJob(jobId);
    if (!job) return { ok: false, error: `Job not found: ${jobId}` };
    if (!job.model || !job.resident) {
      return {
        ok: false,
        error: `Job "${job.name}" is not a resident subagent job — ask requires model + resident=true. Update the job or re-add it with resident=true.`,
      };
    }
    if (!CronScheduler.isLoadedFor(job, this.ctx.sessionManager.getSessionId())) {
      return { ok: false, error: `Job "${job.name}" belongs to another session.` };
    }
    if (this.activeJobs.has(jobId)) {
      return {
        ok: false,
        error: `Job "${job.name}" is busy (a beat is currently running); retry in a moment.`,
      };
    }
    this.activeJobs.add(jobId);
    try {
      const resident = await this.getOrCreateResident(job);
      if (!resident.ok) return { ok: false, error: resident.error };
      const result = await promptSubagentSession(resident.record.handle.session, question);
      resident.record.estChars +=
        question.length + (result.ok ? result.text.length : result.error.length);
      archiveRun(this.logBaseDir, this.ctx.cwd, job.id, {
        ts: new Date().toISOString(),
        outcome: result.ok ? "ok" : "error",
        kind: "ask",
        model: resident.record.handle.modelRef,
        requestedModel: resident.record.handle.requestedModel,
        ...(result.ok
          ? { output: result.text || undefined }
          : { error: result.error }),
      });
      if (result.ok) this.maybeResetResident(job, result.text);
      return result;
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  /** Recent text-only dialogue of a job's resident session — the "view the
   *  subagent's conversation" channel. Bounded per message; live only (the
   *  archive covers completed runs). */
  residentTranscript(
    jobId: string,
    tail = 20,
  ): { ok: true; beats: number; model: string; lines: string[] } | { ok: false; error: string } {
    const record = this.residentSessions.get(jobId);
    if (!record) {
      const job = this.storage.getJob(jobId);
      if (!job) return { ok: false, error: `Job not found: ${jobId}` };
      if (!job.resident) {
        return {
          ok: false,
          error: `Job "${job.name}" has no resident session (resident=false). Use action="logs" for archived outputs.`,
        };
      }
      return {
        ok: false,
        error: `Job "${job.name}" has not fired yet — its resident session is created on the first beat.`,
      };
    }
    const limit = Math.min(Math.max(Math.trunc(tail) || 20, 1), 100);
    const lines: string[] = [];
    for (const msg of record.handle.session.messages as Array<{
      role?: string;
      content?: unknown;
    }>) {
      const role = msg.role ?? "user";
      let text = "";
      const content = msg.content;
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .map((p) =>
            p && typeof p === "object" && (p as { type?: string }).type === "text"
              ? String((p as { text?: string }).text ?? "")
              : "",
          )
          .join("");
      }
      text = stripTerminalCodes(text).trim();
      if (!text) continue;
      lines.push(`${role}: ${text.length > 1000 ? `${text.slice(0, 1000)}…` : text}`);
    }
    return { ok: true, beats: record.beats, model: record.handle.modelRef, lines: lines.slice(-limit) };
  }

  /**
   * Run a job's prompt in an in-process AgentSession with the selected model.
   * Non-resident jobs get a fresh session per fire; resident jobs reuse one
   * session (trend memory) with a bounded transcript. `current`/`same` and
   * `fast` are resolved at fire time for fresh jobs and pinned at creation
   * for resident ones.
   */
  private async executeJobInSubagent(job: CronJob): Promise<void> {
    const startedAt = Date.now();
    const requestedModel = job.model!;
    const resolvedModel = resolveModel(this.ctx.modelRegistry, requestedModel, this.currentModel);
    const model = resolvedModel ? modelReference(resolvedModel) : requestedModel;
    this.storage.updateJob(job.id, { lastStatus: "running" });
    this.emitChange({ type: "fire", job });

    // Quiet jobs (displayOn anomaly/never) post no start marker: the outcome
    // is unknown at fire time, so silence is the safe default — the widget's
    // ⟳ row already communicates "running" without a chat message.
    if (shouldDisplay(job, "", false)) {
      // Start marker needs non-empty content to prevent session poisoning.
      // Pi-ai's openai-completions provider filters out user messages with
      // empty content — if the marker lands right after an assistant message,
      // the conversation ends on assistant and Anthropic 400s.
      try {
        this.pi.sendMessage({
          customType: "scheduled_prompt",
          content: [{ type: "text", text: `🕐 Scheduled (subagent: ${model}): ${job.name}` }],
          display: true,
          details: {
            jobId: job.id,
            jobName: job.name,
            prompt: job.prompt,
            mode: "subagent_start",
            model,
            requestedModel,
          },
        });
      } catch (error) {
        this.storage.updateJob(job.id, {
          lastRun: new Date().toISOString(),
          lastStatus: "error",
        });
        console.error(`Failed to post subagent_start marker for job ${job.id}:`, error);
        return;
      }
    }

    const controller = new AbortController();
    this.activeSubagents.add(controller);

    try {
      let result: SubagentResult;
      if (job.resident) {
        try {
          const resident = await this.getOrCreateResident(job);
          if (!resident.ok) {
            result = { ok: false, error: resident.error };
          } else {
            const beatPrompt = resident.seed
              ? `${resident.seed}\n\n--- Scheduled beat prompt (this and later messages are recurring beats):\n${job.prompt}${STATUS_CONVENTION}`
              : `${job.prompt}${STATUS_CONVENTION}`;
            result = await promptSubagentSession(
              resident.record.handle.session,
              beatPrompt,
              controller.signal,
            );
            resident.record.beats += 1;
            resident.record.estChars +=
              beatPrompt.length + (result.ok ? result.text.length : result.error.length);
            if (result.ok) this.maybeResetResident(job, result.text);
          }
        } finally {
          this.activeSubagents.delete(controller);
        }
      } else if (await this.subagentsRpc.ready()) {
        // Default runner: spawn through pi-subagents so every beat shows up in
        // the user's /agents conversation views (scrollable, steerable). Trend
        // memory comes from the run archive instead of a live session. The
        // controller's signal cancels the wait AND stops the host-side agent
        // on scheduler shutdown.
        try {
          if (!resolvedModel) {
            // Never forward an unresolved alias — the host's registry does
            // not know this plugin's `fast`/`current` spellings.
            result = {
              ok: false,
              error: `Unknown model '${requestedModel}'. ${describeAvailableModels(this.ctx.modelRegistry)}`,
            };
          } else {
            const handle = `hb-${job.name}`
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "")
              .slice(0, 32);
            result = await this.subagentsRpc.spawnAndWait(
              {
                type: job.agentType ?? "general-purpose",
                prompt: `${job.prompt}${STATUS_CONVENTION}${this.recentBeatsMemory(job)}`,
                name: handle || "hb",
                description: `heartbeat: ${job.name}`,
                model,
                isBackground: true,
              },
              BEAT_TIMEOUT_MS,
              controller.signal,
            );
          }
        } finally {
          this.activeSubagents.delete(controller);
        }
      } else {
        try {
          result = await runSubagentOnce(
            this.ctx,
            `${job.prompt}${STATUS_CONVENTION}`,
            requestedModel,
            controller.signal,
            {
              extensions: job.extensions,
              skills: job.skills,
            },
          );
        } finally {
          this.activeSubagents.delete(controller);
        }
      }

      // Scheduler was stopped (session shutdown / switch / fork) while we were
      // running. Don't touch storage or post markers — pi may be invalidated.
      if (controller.signal.aborted) return;

      // The job may have been removed while the beat ran — never write
      // completion state or post markers for a dead job.
      if (!this.storage.getJob(job.id)) return;

      const nextRun = this.getNextRun(job.id);

      // Always advance the storage state to a terminal status BEFORE attempting
      // to post the marker. The marker is best-effort (pi may be invalidated
      // during teardown) and must never leave the job stuck in "running".
      if (result.ok) {
        const rawOutput = result.text.trim();
        const outputSnippet = snippet(rawOutput) || "(subagent produced no text output)";
        // Whole-line marker match only: an agent *mentioning* the stop token
        // in prose ("E2E_STOP not observed") must not terminate the job.
        const stopRequested = Boolean(
          job.stopOn && new RegExp(`^\\s*${escapeRegExp(job.stopOn)}\\s*$`, "m").test(rawOutput),
        );
        const anomalous = isAnomalyOutput(rawOutput);
        const statusLine = extractStatusLine(rawOutput);
        // Re-read runCount from storage; `job` here is the closure-captured
        // snapshot from scheduleJob and would yield a stale count.
        const latest = this.storage.getJob(job.id);
        const currentRunCount = latest?.runCount ?? job.runCount;
        const previousOutcome = latest?.lastOutcome;
        const previousStreak = latest?.lastAlertStreak ?? 0;
        const streak = anomalous ? (previousOutcome === "anomaly" ? previousStreak + 1 : 1) : 0;
        this.storage.updateJob(job.id, {
          lastRun: new Date().toISOString(),
          lastStatus: "success",
          lastOutcome: anomalous ? "anomaly" : "ok",
          lastAlertStreak: streak,
          runCount: currentRunCount + 1,
          nextRun: nextRun?.toISOString(),
          ...(statusLine !== undefined
            ? { lastStatusLine: statusLine, lastStatusLineAt: new Date().toISOString() }
            : {}),
          ...(stopRequested ? { enabled: false } : {}),
        });
        if (stopRequested) {
          // Preserve the terminal result, but do not wait for the next tick
          // to discover that the completion marker was reached.
          this.unscheduleJob(job.id);
          this.emitChange({ type: "update", job: { ...job, enabled: false } });
        }
        this.emitChange({ type: "fire", job });
        archiveRun(this.logBaseDir, this.ctx.cwd, job.id, {
          ts: new Date().toISOString(),
          outcome: anomalous ? "anomaly" : "ok",
          model,
          requestedModel,
          durationMs: Date.now() - startedAt,
          output: rawOutput || undefined,
        });
        // Quiet healthy runs (display gate closed + no wake): no marker at
        // all — zero chat rows, zero parent-context growth. The run stays
        // visible in the widget and in the on-disk archive (action="logs").
        const displayEligible = shouldDisplay(job, rawOutput, false);
        let wakeEligible = shouldNotify(job, rawOutput, false);
        // Wake suppression: with notifyOn=anomaly, a PERSISTENT anomaly wakes
        // the parent only on its first beat and then every ALERT_REWAKE_EVERY-th,
        // so a lingering condition cannot ring every tick. The widget ⚠ and
        // the archive keep it visible between wakes.
        if (
          wakeEligible &&
          anomalous &&
          job.notifyOn === "anomaly" &&
          streak > 1 &&
          streak % ALERT_REWAKE_EVERY !== 0
        ) {
          wakeEligible = false;
        }
        // Recovery marker (display-only, never wakes): the previous beat was
        // anomalous or failed and this one is healthy again. Quiet jobs stay
        // fully silent — the widget ⚠ simply clears.
        if (displayEligible && previousOutcome && previousOutcome !== "ok" && !anomalous) {
          try {
            this.pi.sendMessage(
              {
                customType: "scheduled_prompt",
                content: [
                  {
                    type: "text",
                    text: `✓ Recovered: job "${job.name}" is healthy again (previous outcome: ${previousOutcome}).`,
                  },
                ],
                display: true,
                details: {
                  jobId: job.id,
                  jobName: job.name,
                  prompt: job.prompt,
                  mode: "subagent_recovered",
                },
              },
              undefined,
            );
          } catch (markerErr) {
            console.error(`Failed to post subagent_recovered marker for job ${job.id}:`, markerErr);
          }
        }
        if (displayEligible || wakeEligible) {
          try {
            this.pi.sendMessage(
              {
                customType: "scheduled_prompt",
                content: [{ type: "text", text: outputSnippet }],
                display: displayEligible,
                details: {
                  jobId: job.id,
                  jobName: job.name,
                  prompt: job.prompt,
                  mode: "subagent_done",
                  model,
                  requestedModel,
                  output: outputSnippet,
                },
              },
              wakeEligible ? { deliverAs: "followUp", triggerTurn: true } : undefined,
            );
          } catch (markerErr) {
            console.error(`Failed to post subagent_done marker for job ${job.id}:`, markerErr);
          }
        }
      } else {
        // Truncate the error the same way as the success snippet — verbose
        // API errors / stack traces would otherwise overflow the chat row.
        const errorSnippet = snippet(result.error.trim()) || "(subagent failed with empty error)";
        this.storage.updateJob(job.id, {
          lastRun: new Date().toISOString(),
          lastStatus: "error",
          lastOutcome: "error",
          nextRun: nextRun?.toISOString(),
        });
        this.emitChange({ type: "error", jobId: job.id, error: errorSnippet });
        archiveRun(this.logBaseDir, this.ctx.cwd, job.id, {
          ts: new Date().toISOString(),
          outcome: "error",
          model,
          requestedModel,
          durationMs: Date.now() - startedAt,
          error: result.error.trim() || undefined,
        });
        // Failures always count as anomalous for display gating; only an
        // explicit displayOn="never" hides the error row — wake per
        // notifyOn still applies independently.
        const displayEligible = shouldDisplay(job, errorSnippet, true);
        const wakeEligible = shouldNotify(job, errorSnippet, true);
        if (displayEligible || wakeEligible) {
          try {
            this.pi.sendMessage(
              {
                customType: "scheduled_prompt",
                content: [{ type: "text", text: errorSnippet }],
                display: displayEligible,
                details: {
                  jobId: job.id,
                  jobName: job.name,
                  prompt: job.prompt,
                  mode: "subagent_error",
                  model,
                  requestedModel,
                  error: errorSnippet,
                },
              },
              wakeEligible ? { deliverAs: "followUp", triggerTurn: true } : undefined,
            );
          } catch (markerErr) {
            console.error(`Failed to post subagent_error marker for job ${job.id}:`, markerErr);
          }
        }
      }
    } catch (error) {
      // Backstop: storage or marker failures must not become unhandled rejections.
      console.error(`Subagent completion handler failed for job ${job.id}:`, error);
    }
  }

  /**
   * Emit a change event via pi.events
   */
  private emitChange(event: CronChangeEvent): void {
    this.pi.events.emit("cron:change", event);
  }

  /**
   * Validate a cron expression (must be 6-field format with seconds)
   */
  static validateCronExpression(expression: string): { valid: boolean; error?: string } {
    // Count fields - must be 6 (second minute hour dom month dow)
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 6) {
      return {
        valid: false,
        error: `Cron expression must have 6 fields (second minute hour dom month dow), got ${fields.length}. Example: "0 * * * * *" for every minute`,
      };
    }

    try {
      // Try parsing as cron expression
      new Cron(expression, () => {});
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : "Invalid cron expression",
      };
    }
  }

  /**
   * Parse relative time delta (e.g., "+10s", "+5m", "+1h")
   * Returns ISO timestamp if valid, null otherwise
   */
  static parseRelativeTime(delta: string): string | null {
    const match = delta.match(/^\+(\d+)(s|m|h|d)$/);
    if (!match) return null;

    const value = parseInt(match[1], 10);
    const unit = match[2];
    
    const msMap: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };

    const ms = value * msMap[unit];
    const futureTime = new Date(Date.now() + ms);
    return futureTime.toISOString();
  }

  /**
   * Parse interval string to milliseconds
   */
  static parseInterval(interval: string): number | null {
    const match = interval.match(/^(\d+)(s|m|h|d)$/);
    if (!match) return null;

    const value = parseInt(match[1], 10);
    const unit = match[2];

    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };

    return value * multipliers[unit];
  }

  /**
   * Validate and resolve a schedule string for the given type.
   * Single source of truth shared by tool `add`/`update` and the UI command.
   *
   * - `cron`: validates the 6-field expression
   * - `once`: accepts ISO timestamps and relative time (`+10s`); rejects past
   *   timestamps and ones <5s away (the agent should use relative time instead)
   * - `interval`: accepts duration strings (`5m`, `1h`, `30s`)
   */
  static validateSchedule(type: CronJobType, schedule: string): ValidateScheduleResult {
    if (type === "interval") {
      const intervalMs = CronScheduler.parseInterval(schedule);
      if (!intervalMs) {
        return {
          ok: false,
          error: `Invalid interval format: ${schedule}. Use format like '5m', '1h', '30s'`,
        };
      }
      return { ok: true, schedule, intervalMs };
    }

    if (type === "once") {
      const relative = CronScheduler.parseRelativeTime(schedule);
      if (relative) return { ok: true, schedule: relative };

      const date = new Date(schedule);
      if (Number.isNaN(date.getTime())) {
        return {
          ok: false,
          error: `Invalid timestamp: ${schedule}. Use ISO format or relative time like '+10s', '+5m'`,
        };
      }
      const delay = date.getTime() - Date.now();
      if (delay < 0) {
        return {
          ok: false,
          error: `Timestamp is in the past: ${date.toISOString()}. Current time: ${new Date().toISOString()}`,
        };
      }
      if (delay < 5000) {
        return {
          ok: false,
          error: `Timestamp is too soon (${Math.round(delay / 1000)}s). For delays under 5s, use relative time like '+${Math.ceil(delay / 1000)}s' instead, or schedule at least 5s in the future.`,
        };
      }
      return { ok: true, schedule: date.toISOString() };
    }

    // cron
    const validation = CronScheduler.validateCronExpression(schedule);
    if (!validation.valid) {
      return { ok: false, error: `Invalid cron expression: ${validation.error}` };
    }
    return { ok: true, schedule };
  }

  /**
   * Render a resolved schedule as a short human-readable phrase.
   * Used for confirm dialogs and the widget. `schedule` is the resolved form
   * returned by `validateSchedule` (ISO for `once`).
   */
  static describeSchedule(type: CronJobType, schedule: string): string {
    if (type === "interval") return `every ${schedule}`;
    if (type === "once") {
      const date = new Date(schedule);
      return Number.isNaN(date.getTime()) ? schedule : formatISOShort(date);
    }
    return humanizeCron(schedule);
  }
}

const HUMANIZED_CRON: Record<string, string> = {
  "* * * * * *": "every second",
  "0 * * * * *": "every minute",
  "0 */5 * * * *": "every 5 min",
  "0 */10 * * * *": "every 10 min",
  "0 */15 * * * *": "every 15 min",
  "0 */30 * * * *": "every 30 min",
  "0 0 * * * *": "every hour",
  "0 0 */2 * * *": "every 2 hours",
  "0 0 */3 * * *": "every 3 hours",
  "0 0 */6 * * *": "every 6 hours",
  "0 0 0 * * *": "daily",
  "0 0 0 * * 0": "weekly",
  "0 0 0 1 * *": "monthly",
  "0 0 9 * * 1-5": "9am weekdays",
  "0 0 0 * * 1-5": "weekdays",
  "0 0 0 * * 0,6": "weekends",
};

/** Human-readable form of a 6-field cron expression for common patterns.
 *  Falls back to the raw expression for anything not recognized — never
 *  guesses a wrong description. Callers truncate for column-width displays. */
export function humanizeCron(expression: string): string {
  const normalized = expression.trim();
  if (HUMANIZED_CRON[normalized]) return HUMANIZED_CRON[normalized];

  const minMatch = normalized.match(/^0 \*\/(\d+) \* \* \* \*$/);
  if (minMatch) return `every ${minMatch[1]} min`;

  const hourMatch = normalized.match(/^0 0 \*\/(\d+) \* \* \*$/);
  if (hourMatch) return `every ${hourMatch[1]}h`;

  const timeMatch = normalized.match(/^0 0 (\d+) \* \* \*$/);
  if (timeMatch) return `daily at ${parseInt(timeMatch[1], 10)}:00`;

  return normalized;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Compact ISO timestamp render: "Feb 13 15:30". Returns the input unchanged
 *  if it doesn't parse as a date. */
export function formatISOShort(input: Date | string): string {
  const date = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return String(input);
  const month = MONTHS[date.getMonth()];
  const day = date.getDate();
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${month} ${day} ${hours}:${minutes}`;
}
