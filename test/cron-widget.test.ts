import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { CronScheduler } from "../src/scheduler.js";
import type { CronStorage } from "../src/storage.js";
import type { CronJob } from "../src/types.js";
import { CronWidget, type WidgetStyle } from "../src/ui/cron-widget.js";

function makeStorage(jobs: CronJob[]): CronStorage {
  return {
    getJob: vi.fn((id: string) => jobs.find((j) => j.id === id)),
    getAllJobs: vi.fn(() => jobs),
    addJob: vi.fn(),
    removeJob: vi.fn(),
    updateJob: vi.fn(),
  } as any;
}

function makeScheduler(_jobs: CronJob[]): CronScheduler {
  return {
    getNextRun: vi.fn(() => null),
    isLoadedFor: vi.fn(() => true),
  } as any;
}

function makeSchedulerWithNextRun(nextRun: Date | null): CronScheduler {
  return {
    getNextRun: vi.fn(() => nextRun),
    isLoadedFor: vi.fn(() => true),
  } as any;
}

function makePi(): ExtensionAPI {
  return {
    events: { on: vi.fn(() => () => {}) },
  } as any;
}

function makeCtx(): any {
  return {
    ui: {
      setWidget: vi.fn(),
    },
  };
}

/** Theme whose color functions are identity — lets tests assert plain text. */
function identityTheme(): any {
  const identity = (s: string) => s;
  return {
    fg: (_color: string, s: string) => s,
    bold: identity,
    dim: identity,
    error: identity,
    success: identity,
    warning: identity,
    muted: identity,
    accent: identity,
    text: identity,
  };
}

function exampleJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-1",
    name: "Test Job",
    schedule: "0 * * * * *",
    type: "cron",
    prompt: "say hello",
    enabled: true,
    ...overrides,
  } as CronJob;
}

function mountWidget(jobs: CronJob[], style: WidgetStyle, scheduler?: CronScheduler) {
  const storage = makeStorage(jobs);
  const sched = scheduler ?? makeScheduler(jobs);
  const pi = makePi();
  const ctx = makeCtx();
  const widget = new CronWidget(storage, sched as any, pi, () => style, "test-session");
  return { widget, ctx };
}

/** Mount at the given style and render through the registered widget factory. */
function renderWidget(
  jobs: CronJob[],
  style: WidgetStyle,
  width = 100,
  scheduler?: CronScheduler,
): string[] {
  const { widget, ctx } = mountWidget(jobs, style, scheduler);
  widget.show(ctx);
  expect(ctx.ui.setWidget).toHaveBeenCalledTimes(1);
  const factory = ctx.ui.setWidget.mock.calls[0][1];
  const impl = factory(null, identityTheme());
  return impl.render(width);
}

function renderCompact(
  jobs: CronJob[],
  opts: { width?: number; nextRun?: Date | null } = {},
): string[] {
  const scheduler = makeSchedulerWithNextRun(opts.nextRun === undefined ? null : opts.nextRun);
  return renderWidget(jobs, "compact", opts.width ?? 100, scheduler);
}

describe("CronWidget — render", () => {
  it("handles jobs with undefined runCount without crashing", () => {
    const job = exampleJob({ runCount: undefined });
    const storage = makeStorage([job]);
    const scheduler = makeScheduler([job]);
    const pi = makePi();
    const ctx = makeCtx();

    const widget = new CronWidget(storage, scheduler as any, pi, () => "table", "test-session");
    widget.show(ctx);

    expect(ctx.ui.setWidget).toHaveBeenCalledTimes(1);
    const widgetFactory = ctx.ui.setWidget.mock.calls[0][1];
    const theme = { fg: () => {}, bold: (s: string) => s, error: (s: string) => s, success: (s: string) => s, warning: (s: string) => s, muted: (s: string) => s, accent: (s: string) => s, text: (s: string) => s };
    const widgetImpl = widgetFactory(null, theme);
    expect(() => widgetImpl.render(100)).not.toThrow();
  });
});

describe("CronWidget — compact style", () => {
  it("renders one borderless line with heart prefix, status line, and next run", () => {
    const job = exampleJob({
      name: "health",
      lastStatusLine: "STATUS: all good",
      lastOutcome: "ok",
    });
    const lines = renderCompact([job], {
      // 12.5min out: floor() to "in 12m" tolerates test-run drift.
      nextRun: new Date(Date.now() + 12.5 * 60 * 1000),
    });

    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).toContain("♥");
    expect(line).toContain("health");
    expect(line).toContain("STATUS: all good");
    expect(line).toContain("in 12m");
    // No DynamicBorder / table chrome in compact mode.
    expect(line).not.toContain("─");
    expect(line).not.toContain("┌");
    expect(line).not.toContain("Scheduled Prompts");
  });

  it("falls back to the humanized schedule when there is no status line", () => {
    const job = exampleJob({ name: "standup", schedule: "0 0 9 * * 1-5" });
    const lines = renderCompact([job]);
    expect(lines[0]).toContain("9am weekdays");
  });

  it("sanitizes ANSI escapes out of the status line", () => {
    const job = exampleJob({ name: "noisy", lastStatusLine: "\x1b[31mSTATUS: ok\x1b[0m" });
    const lines = renderCompact([job]);
    expect(lines[0]).not.toContain("\x1b");
    expect(lines[0]).toContain("STATUS: ok");
  });

  it("orders error and anomaly before ok, disabled last", () => {
    const ok = exampleJob({ id: "a", name: "aa-ok" });
    const anomaly = exampleJob({ id: "b", name: "bb-anomaly", lastOutcome: "anomaly" });
    const error = exampleJob({ id: "c", name: "cc-error", lastStatus: "error" });
    const off = exampleJob({ id: "d", name: "dd-off", enabled: false });

    const line = renderCompact([ok, anomaly, error, off])[0];

    const iErr = line.indexOf("cc-error");
    const iAnom = line.indexOf("bb-anomaly");
    const iOk = line.indexOf("aa-ok");
    const iOff = line.indexOf("dd-off");
    expect(iErr).toBeGreaterThanOrEqual(0);
    expect(iAnom).toBeGreaterThanOrEqual(0);
    expect(iOk).toBeGreaterThanOrEqual(0);
    expect(iOff).toBeGreaterThanOrEqual(0);
    expect(iErr).toBeLessThan(iAnom);
    expect(iAnom).toBeLessThan(iOk);
    expect(iOk).toBeLessThan(iOff);

    expect(line).toContain("!");
    expect(line).toContain("⚠");
    expect(line).toContain("✓");
    expect(line).toContain("✗");
  });

  it("joins multiple entries with the dot separator", () => {
    const a = exampleJob({ id: "1", name: "one", lastStatusLine: "s1" });
    const b = exampleJob({ id: "2", name: "two", lastStatusLine: "s2" });
    const lines = renderCompact([a, b]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("one");
    expect(lines[0]).toContain("two");
    expect(lines[0]).toContain("·");
  });

  it("drops entries that do not fit and ends with +N within the width", () => {
    const mk = (id: string, name: string, status: string) =>
      exampleJob({ id, name, lastStatusLine: status });
    const jobs = [
      mk("1", "first-job-with-long-name", "step 3/10 done"),
      mk("2", "second-job-with-long-name", "step 7/10 done"),
      mk("3", "third-job-with-long-name", "step 9/10 done"),
      mk("4", "fourth-job-with-long-name", "waiting"),
    ];

    const lines = renderCompact(jobs, { width: 60 });
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    expect(line).toContain("first-job");
    expect(line).not.toContain("second-job");
    expect(line).toMatch(/\+\d+$/);
  });

  it("keeps the line within width even for degenerate narrow widths", () => {
    const job = exampleJob({ name: "x".repeat(80), lastStatusLine: "y".repeat(60) });
    for (const width of [1, 5, 12, 25]) {
      const lines = renderCompact([job], { width });
      expect(lines).toHaveLength(1);
      expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width);
    }
  });
});

describe("CronWidget — table style", () => {
  it("renders the bordered table unchanged (header, border, row content)", () => {
    const job = exampleJob({ name: "Tabular", lastStatusLine: "not-shown-in-table" });
    const lines = renderWidget([job], "table", 120);

    expect(lines.length).toBeGreaterThan(1);
    const joined = lines.join("\n");
    expect(joined).toContain("─"); // DynamicBorder
    expect(joined).toContain("Scheduled Prompts");
    expect(joined).toContain("(1 jobs)");
    expect(joined).toContain("Tabular");
    expect(joined).toContain("✓");
  });
});

describe("CronWidget — hidden style", () => {
  it("hidden style hides the widget (legacy widgetVisible:false migrates to hidden in settings)", () => {
    const { widget, ctx } = mountWidget([exampleJob()], "hidden");
    widget.show(ctx);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("schedule-prompts", undefined);
  });

  it("auto-hides with zero jobs regardless of style", () => {
    for (const style of ["compact", "table"] as const) {
      const { widget, ctx } = mountWidget([], style);
      widget.show(ctx);
      expect(ctx.ui.setWidget).toHaveBeenCalledWith("schedule-prompts", undefined);
    }
  });
});
