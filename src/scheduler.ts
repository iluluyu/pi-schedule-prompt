import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Cron } from "croner";
import * as path from "path";
import { archiveRun } from "./run-log.js";
import type { CronStorage } from "./storage.js";
import { modelReference, resolveModel, runSubagentOnce, type SubagentResult } from "./subagent.js";
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

const ANOMALY_OUTPUT = /\b(?:HEARTBEAT_ALERT|ALERT|CRITICAL|ERROR|FAILED|OOM|DEAD|UNREACHABLE|BLOCKED)\b/i;

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

  constructor(storage: CronStorage, pi: ExtensionAPI, ctx: ExtensionContext, logBaseDir?: string) {
    this.storage = storage;
    this.pi = pi;
    this.ctx = ctx;
    this.currentModel = ctx.model;
    // Overridable for tests; defaults into the plugin-owned agent dir so
    // quiet-run archives never land inside the user's project tree.
    this.logBaseDir = logBaseDir ?? path.join(getAgentDir(), "schedule-logs");
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

    // Abort any in-flight subagent runs so they don't keep streaming or post
    // markers against a stale pi reference after session shutdown.
    for (const controller of this.activeSubagents) {
      controller.abort();
    }
    this.activeSubagents.clear();
    this.activeJobs.clear();
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
    this.unscheduleJob(id);
    this.emitChange({ type: "remove", jobId: id });
  }

  /**
   * Update a job (reschedule if needed)
   */
  updateJob(id: string, updated: CronJob): void {
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

    console.log(`Executing scheduled prompt: ${fresh.name} (${fresh.id})`);

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

  /**
   * Run a job's prompt in a fresh in-process AgentSession with the selected
   * model. `current`/`same` and `fast` are resolved at fire time, so changing
   * the main model does not leave a heartbeat pinned to an old model.
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
      try {
        result = await runSubagentOnce(this.ctx, job.prompt, requestedModel, controller.signal, {
          extensions: job.extensions,
          skills: job.skills,
        });
      } finally {
        this.activeSubagents.delete(controller);
      }

      // Scheduler was stopped (session shutdown / switch / fork) while we were
      // running. Don't touch storage or post markers — pi may be invalidated.
      if (controller.signal.aborted) return;

      const nextRun = this.getNextRun(job.id);

      // Always advance the storage state to a terminal status BEFORE attempting
      // to post the marker. The marker is best-effort (pi may be invalidated
      // during teardown) and must never leave the job stuck in "running".
      if (result.ok) {
        const rawOutput = result.text.trim();
        const outputSnippet = snippet(rawOutput) || "(subagent produced no text output)";
        const stopRequested = Boolean(job.stopOn && rawOutput.includes(job.stopOn));
        const anomalous = isAnomalyOutput(rawOutput);
        // Re-read runCount from storage; `job` here is the closure-captured
        // snapshot from scheduleJob and would yield a stale count.
        const latest = this.storage.getJob(job.id);
        const currentRunCount = latest?.runCount ?? job.runCount;
        this.storage.updateJob(job.id, {
          lastRun: new Date().toISOString(),
          lastStatus: "success",
          lastOutcome: anomalous ? "anomaly" : "ok",
          runCount: currentRunCount + 1,
          nextRun: nextRun?.toISOString(),
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
        const wakeEligible = shouldNotify(job, rawOutput, false);
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
