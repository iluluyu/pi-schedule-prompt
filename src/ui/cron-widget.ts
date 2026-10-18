/**
 * CronWidget — displays scheduled prompts below the editor
 *
 * Two styles: "compact" (default; one borderless status line: icon, name,
 * last STATUS: line, next run) and "table" (bordered table with status, name,
 * schedule, next run, last run, and run count). "hidden" mounts nothing.
 * Auto-refreshes every 30 seconds to update relative times
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

/** Status icon for a job — shared by the table rows and the compact line. */
function statusIconFor(job: CronJob, theme: any): string {
  if (!job.enabled) {
    return theme.fg("muted", "✗");
  }
  if (job.lastStatus === "running") {
    return theme.fg("warning", "⟳");
  }
  if (job.lastStatus === "error") {
    return theme.fg("error", "!");
  }
  if (job.lastOutcome === "anomaly") {
    // Succeeded but the output matched the anomaly regex — surfaced in
    // chat when displayOn allows, still flagged here afterwards.
    return theme.fg("warning", "⚠");
  }
  return theme.fg("success", "✓");
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

/**
 * Format relative time (e.g., "in 5m", "2h ago")
 */
function formatRelativeTime(date: Date | string): string {
  const now = Date.now();
  const target = typeof date === "string" ? new Date(date).getTime() : date.getTime();
  const diff = target - now;
  const absDiff = Math.abs(diff);

  const seconds = Math.floor(absDiff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  let timeStr: string;
  if (days > 0) {
    timeStr = `${days}d`;
  } else if (hours > 0) {
    timeStr = `${hours}h`;
  } else if (minutes > 0) {
    timeStr = `${minutes}m`;
  } else {
    timeStr = `${seconds}s`;
  }

  return diff > 0 ? `in ${timeStr}` : `${timeStr} ago`;
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
      { placement: "belowEditor" },
    );

    // 30s tick re-renders so relative-time labels ("in 5m") update even when
    // nothing else changes. Same path as cron:change-driven refresh.
    if (!this.refreshInterval) {
      this.refreshInterval = setInterval(() => this.refresh(), 30000);
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

  /** Compact style: one borderless status line. At most MAX_COMPACT_JOBS
   *  entries — highest urgency first — share the width EQUALLY; each entry
   *  compresses internally (identity > progress > next-run) instead of whole
   *  jobs being dropped, and overflow beyond the cap is simply not shown
   *  (the table style remains the full view). */
  private renderCompact(width: number, theme: any): string[] {
    const jobs = this.uniqueJobs().slice().sort((a, b) => compactRank(a) - compactRank(b));
    const prefix = `${theme.fg("error", "♥")} `;
    const separator = " · ";
    const sepWidth = visibleWidth(separator);

    const shown = jobs.slice(0, Math.min(jobs.length, MAX_COMPACT_JOBS));
    const usable = Math.max(0, width - visibleWidth(prefix) - sepWidth * Math.max(0, shown.length - 1));
    const share = shown.length > 0 ? Math.floor(usable / shown.length) : usable;

    const parts = shown.map((job) => this.compactEntryFit(job, theme, Math.max(1, share)));
    const line = prefix + parts.join(separator);

    // Final width safety (e.g. degenerate widths smaller than the prefix).
    return [truncateToWidth(line, width, "")];
  }

  /** One compact entry compressed to `share` columns: identity (icon+name)
   *  survives longest, then the progress detail; the next-run tail is the
   *  first thing dropped under pressure. */
  private compactEntryFit(job: CronJob, theme: any, share: number): string {
    const full = this.compactEntry(job, theme);
    if (visibleWidth(full) <= share) return full;

    const icon = statusIconFor(job, theme);
    const name = job.enabled ? theme.fg("text", job.name) : theme.fg("muted", job.name);
    const head = `${icon} ${name}`;
    const headWidth = visibleWidth(head);
    if (headWidth + 1 >= share) {
      return truncateToWidth(full, Math.max(1, share), "…");
    }
    const detailRaw = sanitizeStatusLine(job.lastStatusLine ?? "") || humanSchedule(job);
    const room = share - headWidth - 1;
    return `${head} ${theme.fg("dim", truncateToWidth(detailRaw, room, "…"))}`;
  }

  /** One compact entry: `icon name` + dim status line (or humanized schedule)
   *  + relative next run. */
  private compactEntry(job: CronJob, theme: any): string {
    const icon = statusIconFor(job, theme);
    const name = job.enabled ? theme.fg("text", job.name) : theme.fg("muted", job.name);
    const detailRaw = sanitizeStatusLine(job.lastStatusLine ?? "") || humanSchedule(job);
    const detail = theme.fg("dim", detailRaw);
    const nextRun = this.scheduler.getNextRun(job.id);
    const parts = [`${icon} ${name}`, detail];
    if (nextRun) parts.push(formatRelativeTime(nextRun));
    return parts.join(" ");
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
