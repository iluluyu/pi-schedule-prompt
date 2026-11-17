/**
 * CronWidget — displays scheduled prompts above the editor
 *
 * Two styles: "compact" (default; one borderless status line with name,
 * state, last STATUS: line and next run) and "table" (bordered job details).
 * "hidden" mounts nothing. Relative times refresh every second.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { CronScheduler, formatISOShort, humanizeCron } from "../scheduler.js";
import type { CronStorage } from "../storage.js";
import type { CronJob } from "../types.js";

const WIDGET_ID = "schedule-prompts";

/** Widget presentation style. `hidden` is the migration endpoint for the
 *  legacy `widgetVisible: false` setting (see settings.ts). */
export type WidgetStyle = "compact" | "table" | "hidden";

/** Cap on entries shown in the compact one-liner; overflow is hidden. */
const MAX_COMPACT_JOBS = 5;

/** Strip ANSI escapes and control characters from a status line before it is
 *  embedded in the compact widget — subagent output is untrusted text. */
function sanitizeStatusLine(line: string): string {
  return line
    .replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g, "")
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Status icon for a job in the compact and table views.
 *  All icons stay in the Geometric Shapes family (font-safe in terminals
 *  that flatten Dingbats/arrows like ✓ ⟳ ✗ ⚠): ● ok, ◐ running,
 *  ■ error, ▲ anomaly, ○ disabled. */
function statusIconFor(job: CronJob, theme: any): string {
  if (!job.enabled) {
    return theme.fg("muted", "○");
  }
  if (job.lastStatus === "running") {
    // Half-filled circle reads as "in progress" without an arrow glyph.
    return theme.fg("warning", "◐");
  }
  if (job.lastStatus === "error") {
    return theme.fg("error", "■");
  }
  if (job.lastOutcome === "anomaly") {
    // Succeeded but the output matched the anomaly regex — surfaced in
    // chat when displayOn allows, still flagged here afterwards.
    return theme.fg("warning", "▲");
  }
  return theme.fg("success", "●");
}

/** Compact-entry sort rank: needs-attention (error/anomaly/running) first,
 *  healthy next, disabled last. */
function compactRank(job: CronJob): number {
  if (!job.enabled) return 4;
  if (job.lastStatus === "error") return 0;
  if (job.lastOutcome === "anomaly") return 1;
  if (job.lastStatus === "running") return 2;
  return 3;
}

/** Humanized schedule text (compact fallback when no status line). */
function humanSchedule(job: CronJob): string {
  if (job.type === "cron") return humanizeCron(job.schedule);
  if (job.type === "once" && job.schedule.includes("T")) return formatISOShort(job.schedule);
  return job.schedule;
}

/** Go-style lowercase duration tokens (30s / 5m / 2h / 1d) — the convention
 *  both humans and models parse most reliably; uppercase M would collide
 *  with ISO-8601 months (P1M) and is the classic misread. */
function compactToken(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function formatRelativeTime(date: Date | string, periodMs?: number | null): string {
  const now = Date.now();
  const target = typeof date === "string" ? new Date(date).getTime() : date.getTime();
  const diff = target - now;
  const token = compactToken(Math.abs(diff));
  // Fallback form (no last beat yet): bare countdown for the future, "+'"
  // for the past; a known period appends the total.
  if (diff > 0) return periodMs ? `${token}/${compactToken(periodMs)}` : token;
  return `${token}+`;
}

/**
 * Create and manage the cron widget
 */
export class CronWidget {
  private refreshInterval?: NodeJS.Timeout;
  private ctx?: any;
  private unsubscribe: () => void;

  constructor(
    private storage: CronStorage,
    private scheduler: CronScheduler,
    private pi: ExtensionAPI,
    private getStyle: () => WidgetStyle,
    private sessionId: string | undefined = undefined,
  ) {
    // Re-render on add/remove/update/fire/error so the row count, status icons,
    // and counters stay current without waiting for the 30s tick.
    this.unsubscribe = this.pi.events.on("cron:change", () => this.refresh());
  }

  /** Jobs this session loads — same predicate as the scheduler. */
  private loadedJobs() {
    return this.storage
      .getAllJobs()
      .filter((j) => CronScheduler.isLoadedFor(j, this.sessionId));
  }

  show(ctx: any): void {
    this.ctx = ctx;

    if (this.getStyle() === "hidden" || this.loadedJobs().length === 0) {
      this.hide(ctx);
      return;
    }

    ctx.ui.setWidget(
      WIDGET_ID,
      (_tui: any, theme: any) => ({
        render: (width: number) => this.renderWidget(width, theme),
        invalidate: () => {},
      }),
      { placement: "aboveEditor" },
    );

    // Refresh countdowns even when no job events occur.
    if (!this.refreshInterval) {
      this.refreshInterval = setInterval(() => this.refresh(), 1000);
    }
  }

  hide(ctx: any): void {
    ctx.ui.setWidget(WIDGET_ID, undefined);
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
  }

  /** Re-mount the widget against the latest storage state. `show` handles the
   *  visibility / empty-list / first-mount cases uniformly. */
  private refresh(): void {
    if (this.ctx) this.show(this.ctx);
  }

  /** Jobs this session loads, deduplicated by ID (safeguard against
   *  rendering issues). */
  private uniqueJobs(): CronJob[] {
    return Array.from(new Map(this.loadedJobs().map((job) => [job.id, job])).values());
  }

  /**
   * Render the widget content
   */
  private renderWidget(width: number, theme: any): string[] {
    return this.getStyle() === "table" ? this.renderTable(width, theme) : this.renderCompact(width, theme);
  }

  /** Compact style: one borderless line with equally sized entry budgets.
   *  The table style remains available for the full job list. */
  private renderCompact(width: number, theme: any): string[] {
    const jobs = this.uniqueJobs().slice().sort((a, b) => compactRank(a) - compactRank(b));
    const prefix = `${theme.fg("dim", "heartbeat")} `;
    const baseSeparator = " · ";
    const sepWidth = visibleWidth(baseSeparator);

    const shown = jobs.slice(0, Math.min(jobs.length, MAX_COMPACT_JOBS));
    const usable = Math.max(0, width - visibleWidth(prefix) - sepWidth * Math.max(0, shown.length - 1));
    const share = shown.length > 0 ? Math.floor(usable / shown.length) : usable;

    const parts = shown.map((job) => this.compactEntryFit(job, theme, Math.max(1, share)));

    return [truncateToWidth(prefix + parts.join(theme.fg("dim", baseSeparator)), width, "")];
  }

  /** One compact entry: name, state when noteworthy, detail, and next run. */
  private compactEntry(job: CronJob, theme: any): string {
    const head = this.compactHead(job, theme);
    const detail = this.compactDetail(job);
    const tail = this.compactTail(job, theme);
    return [head, detail ? theme.fg("dim", detail) : "", tail].filter(Boolean).join(" ");
  }

  /** Compress detail before the job identity and countdown. */
  private compactEntryFit(job: CronJob, theme: any, share: number): string {
    const full = this.compactEntry(job, theme);
    if (visibleWidth(full) <= share) return full;

    const head = this.compactHead(job, theme);
    const tail = this.compactTail(job, theme);
    const headWidth = visibleWidth(head);
    const tailWidth = tail ? visibleWidth(tail) + 1 : 0;

    if (headWidth + tailWidth >= share) {
      return truncateToWidth([head, tail].filter(Boolean).join(" "), Math.max(1, share), "…");
    }
    const detailRaw = this.compactDetail(job);
    const room = share - headWidth - tailWidth - 1;
    const detail = room > 0 && detailRaw ? theme.fg("dim", truncateToWidth(detailRaw, room, "…")) : "";
    return [head, detail, tail].filter(Boolean).join(" ");
  }

  private compactDetail(job: CronJob): string {
    const status = sanitizeStatusLine(job.lastStatusLine ?? "");
    if (status) return status;
    if (job.model && job.enabled && !job.runCount) return "waiting for first run";
    const nextRun = this.scheduler.getNextRun(job.id);
    const period = this.scheduler.getBeatPeriodMs?.(job.id) ?? null;
    return nextRun && period && period > 0 && job.enabled ? "" : humanSchedule(job);
  }

  private compactHead(job: CronJob, theme: any): string {
    const name = job.enabled ? theme.fg("text", job.name) : theme.fg("muted", job.name);
    const icon = statusIconFor(job, theme);
    if (!job.enabled) return `${icon} ${theme.fg("dim", "paused")} ${name}`;
    if (job.lastStatus === "error") return `${icon} ${theme.fg("error", "error")} ${name}`;
    if (job.lastOutcome === "anomaly") return `${icon} ${theme.fg("warning", "anomaly")} ${name}`;
    if (job.lastStatus === "running") return `${icon} ${theme.fg("dim", "running")} ${name}`;
    return `${icon} ${name}`;
  }

  private compactTail(job: CronJob, theme: any): string | null {
    const nextRun = this.scheduler.getNextRun(job.id);
    if (!nextRun) return null;
    const period = this.scheduler.getBeatPeriodMs?.(job.id) ?? null;
    const countdown = theme.fg("dim", formatRelativeTime(nextRun, period));
    if (!period || period <= 0 || !job.enabled) return countdown;
    const elapsed = Math.max(0, Math.min(period, period - (nextRun.getTime() - Date.now())));
    const filled = Math.round((elapsed / period) * 5);
    const bar = theme.fg("accent", "▰".repeat(filled)) + theme.fg("dim", "▱".repeat(5 - filled));
    return `${bar} ${countdown}`;
  }

  /**
   * Render the widget content — bordered per-job table
   */
  private renderTable(width: number, theme: any): string[] {
    const uniqueJobs = this.uniqueJobs();

    const container = new Container();
    const borderColor = (s: string) => theme.fg("accent", s);

    // Header
    container.addChild(new DynamicBorder(borderColor));
    container.addChild(
      new Text(
        theme.fg("accent", theme.bold("Scheduled Prompts")) + theme.fg("dim", ` (${uniqueJobs.length} jobs)`),
        1,
        0
      )
    );
    container.addChild(new Spacer(1));

    // Job rows
    const lines: string[] = [];
    for (const job of uniqueJobs) {
      // Status icon
      const statusIcon = statusIconFor(job, theme);

      // Name (max 15 chars for column, pad before coloring)
      const nameRaw = job.name.length > 15 ? job.name.substring(0, 12) + "..." : job.name;
      const namePadded = nameRaw.padEnd(15);
      const nameText = job.enabled ? theme.fg("text", namePadded) : theme.fg("muted", namePadded);

      // Schedule (max 15 chars for column, pad before coloring). The helpers
      // return full strings; we truncate at the column boundary here.
      let scheduleRaw: string;
      if (job.type === "cron") {
        scheduleRaw = humanizeCron(job.schedule);
      } else if (job.type === "once" && job.schedule.includes("T")) {
        scheduleRaw = formatISOShort(job.schedule);
      } else {
        scheduleRaw = job.schedule;
      }
      if (scheduleRaw.length > 15) scheduleRaw = `${scheduleRaw.substring(0, 12)}...`;
      const schedulePadded = scheduleRaw.padEnd(15);
      const scheduleText = theme.fg("dim", schedulePadded);

      // Prompt (max 25 chars, pad before coloring)
      const promptRaw = job.prompt.length > 25 ? job.prompt.substring(0, 22) + "..." : job.prompt;
      const promptPadded = promptRaw.padEnd(25);
      const promptText = theme.fg("dim", promptPadded);

      // Next run (max 10 chars, pad before coloring)
      const nextRun = this.scheduler.getNextRun(job.id);
      const nextRaw = nextRun ? formatRelativeTime(nextRun) : "-";
      const nextPadded = nextRaw.padEnd(10);
      const nextText = nextPadded;

      // Last run (max 10 chars, pad before coloring)
      const lastRaw = job.lastRun ? formatRelativeTime(job.lastRun) : "never";
      const lastPadded = lastRaw.padEnd(10);
      const lastText = job.lastRun ? lastPadded : theme.fg("dim", lastPadded);

      // Run count (pad to 3 chars for alignment)
      const countText = theme.fg("accent", (job.runCount ?? 0).toString().padEnd(3));

      // Model badge (only for jobs that run in a subagent).
      // Trailing "!" marks jobs that wake the parent agent (notify=true);
      // "~" marks quiet jobs whose healthy runs render nothing (displayOn
      // anomaly/never) — their outputs live in the run archive instead.
      const quiet = job.displayOn === "anomaly" || job.displayOn === "never";
      const modelBadge = job.model
        ? " " + theme.fg("accent",
            `[${job.model.length > 12 ? job.model.substring(0, 9) + "..." : job.model}${job.notify ? "!" : ""}${quiet ? "~" : ""}]`)
        : "";

      // Combine into a row with proper spacing
      lines.push(
        ` ${statusIcon} ${nameText} ${scheduleText} ${promptText} ${nextText} ${lastText} ${countText}${modelBadge}`
      );
    }

    container.addChild(new Text(lines.join("\n"), 1, 0));
    container.addChild(new DynamicBorder(borderColor));

    return container.render(width);
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.unsubscribe();
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }
}
