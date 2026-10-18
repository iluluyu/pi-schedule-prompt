import { beforeEach, describe, expect, it, vi } from "vitest";
import { CronScheduler } from "../src/scheduler.js";
import type { CronJob } from "../src/types.js";

// Mock the subagent runner: scheduler tests don't actually want to spin up an
// in-memory AgentSession, just verify the scheduler's wiring around it.
vi.mock("../src/subagent.js", () => ({
  modelReference: vi.fn(),
  resolveModel: vi.fn(() => undefined),
  runSubagentOnce: vi.fn(),
  createSubagentSession: vi.fn(),
  promptSubagentSession: vi.fn(),
}));

import { createSubagentSession, promptSubagentSession, runSubagentOnce } from "../src/subagent.js";

// Scheduler tests must not touch the real run archive on disk.
vi.mock("../src/run-log.js", () => ({
  archiveRun: vi.fn(),
  readRuns: vi.fn(() => []),
  runLogPath: vi.fn(() => ":memory:"),
}));

import { archiveRun } from "../src/run-log.js";

const mockRunSubagentOnce = vi.mocked(runSubagentOnce);
const mockArchiveRun = vi.mocked(archiveRun);
const mockCreateSubagentSession = vi.mocked(createSubagentSession);
const mockPromptSubagentSession = vi.mocked(promptSubagentSession);

// In-memory CronStorage stand-in.
function makeStorage(seedJobs: CronJob[] = []) {
  const jobs = new Map<string, CronJob>(seedJobs.map((j) => [j.id, j]));
  return {
    hasJobWithName: (name: string) =>
      Array.from(jobs.values()).some((j) => j.name === name),
    addJob: (job: CronJob) => jobs.set(job.id, job),
    removeJob: (id: string) => jobs.delete(id),
    updateJob: (id: string, partial: Partial<CronJob>) => {
      const job = jobs.get(id);
      if (!job) return false;
      Object.assign(job, partial);
      return true;
    },
    getJob: (id: string) => jobs.get(id),
    getAllJobs: () => Array.from(jobs.values()),
    getStorePath: () => ":memory:",
  } as any;
}

// Minimal ExtensionAPI: scheduler only touches sendMessage + events.emit.
function makePi() {
  return {
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn() },
  } as any;
}

function makeCtx(sessionId = "test-session") {
  return {
    cwd: "/tmp",
    modelRegistry: { find: () => undefined, getAvailable: () => [] },
    sessionManager: { getSessionId: () => sessionId },
  } as any;
}

function exampleJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job-1",
    name: "demo",
    schedule: "+10s",
    prompt: "do the thing",
    enabled: true,
    type: "once",
    createdAt: new Date().toISOString(),
    runCount: 0,
    ...overrides,
  };
}

describe("CronScheduler — subagent path marker delivery", () => {
  beforeEach(() => {
    mockRunSubagentOnce.mockReset();
  });

  it("posts a subagent_start marker with brief status text (no delivery options)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "result text" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);

    // First call is the start marker, fired synchronously before the IIFE runs.
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const [startMsg, startOpts] = pi.sendMessage.mock.calls[0];
    expect(startMsg.details.mode).toBe("subagent_start");
    expect(startMsg.details.model).toBe("haiku");
    // Non-empty content prevents session poisoning (empty content gets filtered
    // by pi-ai, leaving conversation ending on assistant — Anthropic 400s).
    expect(startMsg.content.length).toBeGreaterThan(0);
    expect(startMsg.content[0].text.length).toBeGreaterThan(0);
    expect(startOpts).toBeUndefined();
  });

  it("posts a subagent_done marker with non-empty content when notify is unset (prevents session poisoning)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "OK" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [doneMsg, doneOpts] = pi.sendMessage.mock.calls[1];
    expect(doneMsg.details.mode).toBe("subagent_done");
    expect(doneMsg.details.output).toBe("OK");
    // notify=false: no delivery options so parent isn't woken, but content
    // is non-empty to prevent session poisoning (empty content gets filtered
    // by pi-ai, leaving conversation ending on assistant — Anthropic 400s).
    expect(doneMsg.content.length).toBeGreaterThan(0);
    expect(doneMsg.content[0].text).toBe("OK");
    expect(doneOpts).toBeUndefined();
  });

  it("posts a wake-up subagent_done marker when notify is true (followUp + triggerTurn, snippet in content)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "OK" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notify: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [doneMsg, doneOpts] = pi.sendMessage.mock.calls[1];
    expect(doneMsg.content).toEqual([{ type: "text", text: "OK" }]);
    expect(doneOpts).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("only wakes the parent for anomaly output when notifyOn=anomaly", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "HEARTBEAT_OK" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notifyOn: "anomaly" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));
    expect(pi.sendMessage.mock.calls[1][1]).toBeUndefined();

    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "HEARTBEAT_ALERT GPU OOM" });
    pi.sendMessage.mockClear();
    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));
    expect(pi.sendMessage.mock.calls[1][1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("disables a recurring job when its stopOn marker is returned", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "DRIVER_DONE" });
    const pi = makePi();
    const job = exampleJob({
      type: "cron",
      schedule: "0 * * * * *",
      model: "haiku",
      stopOn: "DRIVER_DONE",
    });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(storage.getJob(job.id).lastStatus).toBe("success"));

    expect(storage.getJob(job.id).enabled).toBe(false);
    expect((scheduler as any).jobs.has(job.id)).toBe(false);
  });

  it("posts a subagent_error marker with notify-gated wake-up", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: false, error: "model exploded" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notify: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [errMsg, errOpts] = pi.sendMessage.mock.calls[1];
    expect(errMsg.details.mode).toBe("subagent_error");
    expect(errMsg.details.error).toBe("model exploded");
    expect(errMsg.content).toEqual([{ type: "text", text: "model exploded" }]);
    expect(errOpts).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("truncates output longer than 500 chars with an ellipsis", async () => {
    const longText = "x".repeat(600);
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: longText });
    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [doneMsg] = pi.sendMessage.mock.calls[1];
    expect(doneMsg.details.output).toHaveLength(501); // 500 + ellipsis char
    expect(doneMsg.details.output.endsWith("…")).toBe(true);
  });

  it("truncates long error messages the same way as success snippets", async () => {
    const longErr = "boom ".repeat(200); // 1000 chars
    mockRunSubagentOnce.mockResolvedValue({ ok: false, error: longErr });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notify: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [errMsg] = pi.sendMessage.mock.calls[1];
    // Both `details.error` (renderer) and `content` (LLM, since notify=true)
    // see the truncated form so neither floods the chat with stack traces /
    // verbose API errors.
    expect(errMsg.details.error).toHaveLength(501);
    expect(errMsg.details.error.endsWith("…")).toBe(true);
    expect(errMsg.content[0].text).toEqual(errMsg.details.error);
  });

  it("updates lastStatus and increments runCount on success", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "done" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", runCount: 3 });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(storage.getJob("job-1").lastStatus).toBe("success"));

    const updated = storage.getJob("job-1");
    expect(updated.runCount).toBe(4);
    expect(updated.lastRun).toBeDefined();
  });

  it("updates lastStatus to error and does not advance runCount on failure", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: false, error: "boom" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", runCount: 7 });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(storage.getJob("job-1").lastStatus).toBe("error"));

    expect(storage.getJob("job-1").runCount).toBe(7);
  });
});

  it("uses placeholder text when subagent produces no output with notify=true (#10)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notify: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [doneMsg] = pi.sendMessage.mock.calls[1];
    expect(doneMsg.content[0].text).toBe("(subagent produced no text output)");
  });

  it("uses placeholder text when subagent produces no output with notify=false (#10 + #12)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [doneMsg] = pi.sendMessage.mock.calls[1];
    // Even with notify=false, content must be non-empty to prevent session poisoning.
    expect(doneMsg.content.length).toBeGreaterThan(0);
    expect(doneMsg.content[0].text).toBe("(subagent produced no text output)");
    expect(doneMsg.details.output).toBe("(subagent produced no text output)");
  });

  it("uses placeholder text when subagent errors with empty error message (#10)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: false, error: "" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notify: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [errMsg] = pi.sendMessage.mock.calls[1];
    expect(errMsg.content[0].text).toBe("(subagent failed with empty error)");
  });

  it("uses placeholder text when subagent errors with empty error message and notify=false (#10 + #12)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: false, error: "" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [errMsg] = pi.sendMessage.mock.calls[1];
    expect(errMsg.content.length).toBeGreaterThan(0);
    expect(errMsg.content[0].text).toBe("(subagent failed with empty error)");
    expect(errMsg.details.error).toBe("(subagent failed with empty error)");
  });

  it("uses placeholder text when subagent produces whitespace-only output (edge case)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "   " });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notify: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [doneMsg] = pi.sendMessage.mock.calls[1];
    expect(doneMsg.content[0].text).toBe("(subagent produced no text output)");
  });

  it("uses placeholder text when subagent returns whitespace-only error (edge case)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: false, error: "   " });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notify: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const [errMsg] = pi.sendMessage.mock.calls[1];
    expect(errMsg.content[0].text).toBe("(subagent failed with empty error)");
  });

describe("CronScheduler — start() recovery", () => {
  it("clears stale lastStatus=running on start (interrupted-by-shutdown recovery)", () => {
    // Simulates the previous session crashing/aborting mid-execution: storage
    // ended up with `lastStatus: "running"` because the IIFE bailed out on the
    // abort signal before reaching its terminal-status update. Without the
    // sweep, the widget would render `⟳` for a job that isn't actually running
    // until the cron next fires.
    //
    // Jobs use type=cron with a valid expression so scheduleJob() doesn't
    // overwrite lastStatus during start() (the once-with-past-timestamp path
    // sets lastStatus="error" itself).
    const pi = makePi();
    const cronSchedule = "0 0 * * * *"; // hourly
    const stuckJob = exampleJob({
      id: "stuck", type: "cron", schedule: cronSchedule, lastStatus: "running",
    });
    const cleanJob = exampleJob({
      id: "clean", type: "cron", schedule: cronSchedule, lastStatus: "success",
    });
    const errorJob = exampleJob({
      id: "errored", type: "cron", schedule: cronSchedule, lastStatus: "error",
    });
    const storage = makeStorage([stuckJob, cleanJob, errorJob]);
    const scheduler = new CronScheduler(storage, pi, makeCtx());

    try {
      scheduler.start();

      expect(storage.getJob("stuck").lastStatus).toBeUndefined();
      // Other lastStatus values are left alone — we only sweep the one that
      // signals an interrupted run.
      expect(storage.getJob("clean").lastStatus).toBe("success");
      expect(storage.getJob("errored").lastStatus).toBe("error");
    } finally {
      scheduler.stop(); // tear down the live croner timers we just started
    }
  });
});

describe("CronScheduler — shutdown abort", () => {
  beforeEach(() => {
    mockRunSubagentOnce.mockReset();
  });

  it("aborts in-flight subagents when stop() is called", async () => {
    let receivedSignal: AbortSignal | undefined;
    let resolveRun!: (r: { ok: true; text: string }) => void;
    mockRunSubagentOnce.mockImplementation(async (_ctx, _prompt, _model, signal) => {
      receivedSignal = signal;
      return new Promise((resolve) => {
        resolveRun = resolve;
        signal?.addEventListener("abort", () => resolve({ ok: false, error: "aborted" } as any));
      });
    });

    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    // Wait until the IIFE has actually invoked the runner and we have its signal.
    await vi.waitFor(() => expect(receivedSignal).toBeDefined());
    expect(receivedSignal!.aborted).toBe(false);

    scheduler.stop();
    expect(receivedSignal!.aborted).toBe(true);

    // Cleanup the dangling promise so vitest doesn't complain.
    resolveRun({ ok: true, text: "" });
  });

  it("does not post completion markers for runs aborted by stop()", async () => {
    let resolveRun!: (r: { ok: true; text: string }) => void;
    let signalReceived = false;
    mockRunSubagentOnce.mockImplementation(async (_ctx, _prompt, _model, signal) => {
      signalReceived = true;
      return new Promise((resolve) => {
        resolveRun = resolve;
        signal?.addEventListener("abort", () => resolve({ ok: false, error: "aborted" } as any));
      });
    });

    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(signalReceived).toBe(true));
    expect(pi.sendMessage).toHaveBeenCalledTimes(1); // start only

    scheduler.stop();

    // Wait for the IIFE to clean itself up after abort.
    await vi.waitFor(() => expect((scheduler as any).activeSubagents.size).toBe(0));
    // No done/error marker should be posted because the signal was aborted.
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    resolveRun({ ok: true, text: "" });
  });

  it("clears activeSubagents after a natural completion", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "done" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect((scheduler as any).activeSubagents.size).toBe(0));
  });

  it("survives a thrown sendMessage and still advances storage to a terminal status", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "done" });
    const pi = makePi();
    let firstCall = true;
    pi.sendMessage = vi.fn(() => {
      if (firstCall) {
        firstCall = false;
        return; // start marker succeeds
      }
      throw new Error("pi is stale (simulated teardown)");
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const job = exampleJob({ model: "haiku" });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalled());

    // Storage was advanced before the marker post, so the job is NOT stuck in "running"
    // even though sendMessage threw. This is the regression guard for the "stuck running"
    // failure mode.
    expect(storage.getJob("job-1").lastStatus).toBe("success");
    expect(storage.getJob("job-1").runCount).toBe(1);

    // The marker failure was logged via the inner try/catch (not the outer backstop).
    const loggedMessage = consoleSpy.mock.calls[0][0] as string;
    expect(loggedMessage).toContain(`Failed to post subagent_done marker for job ${job.id}`);
    consoleSpy.mockRestore();
  });
});

describe("CronScheduler — inline path is unaffected by mock", () => {
  beforeEach(() => {
    mockRunSubagentOnce.mockReset();
  });

  it("does not call runSubagentOnce when job has no model", async () => {
    const pi = makePi();
    const job = exampleJob(); // no model
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    await (scheduler as any).executeJob(job);

    expect(mockRunSubagentOnce).not.toHaveBeenCalled();
    // Inline path: marker + sendUserMessage
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage).toHaveBeenCalledWith(
      "do the thing",
      { deliverAs: "followUp" },
    );
  });

  it("inline marker uses empty content and no delivery options (regression guard for double-injection)", async () => {
    const pi = makePi();
    const job = exampleJob(); // no model
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    await (scheduler as any).executeJob(job);

    // The marker must NOT carry the prompt in `content` — that would inject
    // the prompt into the LLM context a second time alongside `sendUserMessage`,
    // producing the "PROMPT\n\nPROMPT" / duplicate-turn symptom. No options
    // means: idle → silent append + emit (marker shows before the user
    // message); streaming → `agent.steer` with empty content (no LLM
    // context change, no extra turn triggered).
    const [markerMsg, markerOpts] = pi.sendMessage.mock.calls[0];
    expect(markerMsg.content).toEqual([]);
    expect(markerMsg.details).toEqual({
      jobId: job.id,
      jobName: job.name,
      prompt: job.prompt,
    });
    expect(markerOpts).toBeUndefined();
  });
});

describe("CronScheduler — session binding filter", () => {
  it("isLoadedFor: unbound job is loaded for any session", () => {
    expect(CronScheduler.isLoadedFor(exampleJob(), "any")).toBe(true);
    expect(CronScheduler.isLoadedFor(exampleJob(), undefined)).toBe(true);
  });

  it("isLoadedFor: bound job loads only for the matching session", () => {
    const j = exampleJob({ session: "A" });
    expect(CronScheduler.isLoadedFor(j, "A")).toBe(true);
    expect(CronScheduler.isLoadedFor(j, "B")).toBe(false);
    expect(CronScheduler.isLoadedFor(j, undefined)).toBe(false);
  });

  it("start() does not schedule foreign-session jobs", () => {
    const pi = makePi();
    const cronSchedule = "0 0 * * * *"; // hourly
    // Mark the foreign job lastStatus=running to also assert the stale-running
    // sweep skips it (we don't touch other sessions' state).
    const mine = exampleJob({
      id: "mine", type: "cron", schedule: cronSchedule, session: "session-A",
    });
    const foreign = exampleJob({
      id: "foreign", type: "cron", schedule: cronSchedule,
      session: "session-B", lastStatus: "running",
    });
    const unbound = exampleJob({
      id: "unbound", type: "cron", schedule: cronSchedule,
    });
    const storage = makeStorage([mine, foreign, unbound]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("session-A"));

    try {
      scheduler.start();
      const jobsMap = (scheduler as any).jobs as Map<string, unknown>;
      expect(jobsMap.has("mine")).toBe(true);
      expect(jobsMap.has("unbound")).toBe(true);
      expect(jobsMap.has("foreign")).toBe(false);
      // Foreign session's stale-running flag is untouched — it's not ours.
      expect(storage.getJob("foreign").lastStatus).toBe("running");
    } finally {
      scheduler.stop();
    }
  });

  it("executeJob bails when storage now reports the job is bound to another session", async () => {
    const pi = makePi();
    const job = exampleJob({ id: "j", session: "session-A" });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("session-B"));

    await (scheduler as any).executeJob(job);

    // No marker, no user message — the defensive re-read caught the mismatch
    // before the scheduler dispatched.
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("executeJob bails when the job has been removed mid-tick", async () => {
    const pi = makePi();
    const job = exampleJob({ id: "j" });
    const storage = makeStorage([]); // job not in storage anymore
    const scheduler = new CronScheduler(storage, pi, makeCtx("session-A"));

    await (scheduler as any).executeJob(job);

    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("executeJob bails when the job was disabled mid-tick (e.g. hand-edited file)", async () => {
    const pi = makePi();
    const job = exampleJob({ id: "j", enabled: false });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("session-A"));

    await (scheduler as any).executeJob(job);

    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("executeJob bails before delegating to subagent when session no longer matches", async () => {
    const pi = makePi();
    const job = exampleJob({ id: "j", model: "haiku", session: "session-A" });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx("session-B"));

    await (scheduler as any).executeJob(job);

    // Guard fires before the model branch — subagent never runs, no markers.
    expect(mockRunSubagentOnce).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
});

describe("CronScheduler.validateSchedule", () => {
  it("interval: accepts valid duration, returns intervalMs", () => {
    const r = CronScheduler.validateSchedule("interval", "5m");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.schedule).toBe("5m");
      expect(r.intervalMs).toBe(5 * 60 * 1000);
    }
  });

  it("interval: rejects garbage with a useful hint", () => {
    const r = CronScheduler.validateSchedule("interval", "five minutes");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("'5m', '1h', '30s'");
  });

  it("once: accepts relative time and resolves to ISO", () => {
    const r = CronScheduler.validateSchedule("once", "+5m");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const t = new Date(r.schedule).getTime();
      expect(t - Date.now()).toBeGreaterThan(4 * 60 * 1000);
      expect(t - Date.now()).toBeLessThan(6 * 60 * 1000);
    }
  });

  it("once: rejects past timestamps", () => {
    const r = CronScheduler.validateSchedule("once", "2000-01-01T00:00:00Z");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("in the past");
  });

  it("once: rejects timestamps under 5s away with a relative-time suggestion", () => {
    const soon = new Date(Date.now() + 2000).toISOString();
    const r = CronScheduler.validateSchedule("once", soon);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("too soon");
      expect(r.error).toMatch(/use relative time like '\+\d+s'/);
    }
  });

  it("once: rejects unparseable timestamps", () => {
    const r = CronScheduler.validateSchedule("once", "not-a-date");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Invalid timestamp");
  });

  it("cron: accepts valid 6-field expression", () => {
    const r = CronScheduler.validateSchedule("cron", "0 0 9 * * *");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.schedule).toBe("0 0 9 * * *");
  });

  it("cron: rejects 5-field expression with field-count error", () => {
    const r = CronScheduler.validateSchedule("cron", "0 9 * * *");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("6 fields");
  });
});

describe("CronScheduler.describeSchedule", () => {
  it("cron: humanizes known patterns", () => {
    expect(CronScheduler.describeSchedule("cron", "0 0 0 * * *")).toBe("daily");
    expect(CronScheduler.describeSchedule("cron", "0 */5 * * * *")).toBe("every 5 min");
  });

  it("cron: returns raw expression untouched for unknown patterns (no guessing)", () => {
    const raw = "15 30 8 1,15 * 1-5";
    expect(CronScheduler.describeSchedule("cron", raw)).toBe(raw);
  });

  it("interval: prefixes with 'every'", () => {
    expect(CronScheduler.describeSchedule("interval", "5m")).toBe("every 5m");
  });

  it("once: renders ISO as 'Mon DD HH:MM'", () => {
    const iso = "2026-02-13T15:30:00.000Z";
    const out = CronScheduler.describeSchedule("once", iso);
    // Format depends on local TZ for the day/hour fields, so just assert shape.
    expect(out).toMatch(/^[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/);
  });
});

describe("CronScheduler — extensions/skills", () => {
  beforeEach(() => {
    mockRunSubagentOnce.mockReset();
  });

  it("passes extensions=true to runSubagentOnce when job has extensions=true", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "OK" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", extensions: true });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const options = mockRunSubagentOnce.mock.calls[0][4];
    expect(options).toEqual({ extensions: true, skills: undefined });
  });

  it("passes extensions=false to runSubagentOnce when job has no extensions", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "OK" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku" }); // no extensions
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const options = mockRunSubagentOnce.mock.calls[0][4];
    expect(options).toEqual({ extensions: undefined, skills: undefined });
  });

  it("passes extensions=false to runSubagentOnce when job has extensions=false", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "OK" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", extensions: false });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    const options = mockRunSubagentOnce.mock.calls[0][4];
    expect(options).toEqual({ extensions: false, skills: undefined });
  });
});

describe("CronScheduler — displayOn quiet mode", () => {
  beforeEach(() => {
    mockRunSubagentOnce.mockReset();
    mockArchiveRun.mockReset();
  });

  it("displayOn=anomaly: healthy run posts no markers at all — zero chat rows, zero context", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "HEARTBEAT_OK all good" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notifyOn: "anomaly", displayOn: "anomaly" });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(storage.getJob(job.id).lastStatus).toBe("success"));

    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(storage.getJob(job.id).runCount).toBe(1);
    expect(storage.getJob(job.id).lastOutcome).toBe("ok");
    expect(mockArchiveRun).toHaveBeenCalledTimes(1);
    expect(mockArchiveRun.mock.calls[0][3]).toMatchObject({
      outcome: "ok",
      output: "HEARTBEAT_OK all good",
    });
    expect(pi.events.emit).toHaveBeenCalled();
  });

  it("displayOn=anomaly: anomalous output posts exactly one done marker (no start marker) with wake", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "HEARTBEAT_ALERT GPU OOM" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notifyOn: "anomaly", displayOn: "anomaly" });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));

    const [msg, opts] = pi.sendMessage.mock.calls[0];
    expect(msg.details.mode).toBe("subagent_done");
    expect(msg.display).toBe(true);
    expect(msg.content[0].text.length).toBeGreaterThan(0);
    expect(opts).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(storage.getJob(job.id).lastOutcome).toBe("anomaly");
    expect(mockArchiveRun.mock.calls[0][3]).toMatchObject({ outcome: "anomaly" });
  });

  it("displayOn=anomaly: failed run posts the error marker with notify-gated wake", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: false, error: "model exploded" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notifyOn: "anomaly", displayOn: "anomaly" });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));

    const [msg, opts] = pi.sendMessage.mock.calls[0];
    expect(msg.details.mode).toBe("subagent_error");
    expect(msg.display).toBe(true);
    expect(opts).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(storage.getJob(job.id).lastOutcome).toBe("error");
    expect(mockArchiveRun.mock.calls[0][3]).toMatchObject({ outcome: "error", error: "model exploded" });
  });

  it("displayOn=never + notifyOn=always: one done marker, display:false but still wakes", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "OK" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notifyOn: "always", displayOn: "never" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));

    const [msg, opts] = pi.sendMessage.mock.calls[0];
    expect(msg.details.mode).toBe("subagent_done");
    expect(msg.display).toBe(false);
    // Content stays non-empty even when not rendered — session poisoning guard.
    expect(msg.content[0].text.length).toBeGreaterThan(0);
    expect(opts).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("classifies anomalies beyond the 500-char snippet boundary (full output)", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "x".repeat(600) + " HEARTBEAT_ALERT" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notifyOn: "anomaly", displayOn: "anomaly" });
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));

    const [msg, opts] = pi.sendMessage.mock.calls[0];
    expect(opts).toEqual({ deliverAs: "followUp", triggerTurn: true });
    // The displayed snippet is still truncated to 500 chars…
    expect(msg.details.output).toHaveLength(501);
  });

  it("stopOn still disables a quiet job when the completion marker is returned", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "DRIVER_DONE" });
    const pi = makePi();
    const job = exampleJob({
      type: "cron",
      schedule: "0 * * * * *",
      model: "haiku",
      notifyOn: "anomaly",
      displayOn: "anomaly",
      stopOn: "DRIVER_DONE",
    });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(storage.getJob(job.id).lastStatus).toBe("success"));

    expect(storage.getJob(job.id).enabled).toBe(false);
    expect((scheduler as any).jobs.has(job.id)).toBe(false);
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("stopOn requires a whole-line marker — prose mentions do not stop the job", async () => {
    mockRunSubagentOnce.mockResolvedValue({
      ok: true,
      text: "HEARTBEAT_OK\n- Stop token DRIVER_DONE not observed; continuing.",
    });
    const job = exampleJob({
      type: "cron",
      schedule: "0 * * * * *",
      model: "haiku",
      stopOn: "DRIVER_DONE",
    });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, makePi(), makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(storage.getJob(job.id).lastStatus).toBe("success"));

    expect(storage.getJob(job.id).enabled).toBe(true);
  });

  it("negated anomaly mentions (\"no ERROR observed\") do not count as anomalies", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "STATUS: ok\nno ERROR observed, not failed" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notifyOn: "anomaly", displayOn: "anomaly" });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(storage.getJob(job.id).lastStatus).toBe("success"));

    expect(storage.getJob(job.id).lastOutcome).toBe("ok");
    expect(pi.sendMessage).not.toHaveBeenCalled(); // healthy → fully quiet
  });

  it("legacy jobs without displayOn keep the historical start+done markers", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "OK" });
    const pi = makePi();
    const job = exampleJob({ model: "haiku", notifyOn: "anomaly" }); // no displayOn
    const scheduler = new CronScheduler(makeStorage([job]), pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));

    expect(pi.sendMessage.mock.calls[0][0].details.mode).toBe("subagent_start");
    expect(pi.sendMessage.mock.calls[1][0].details.mode).toBe("subagent_done");
    expect(pi.sendMessage.mock.calls[1][0].display).toBe(true);
    expect(pi.sendMessage.mock.calls[1][1]).toBeUndefined(); // anomaly, healthy → no wake
  });
});

describe("CronScheduler — resident sessions, status lines, alert suppression", () => {
  beforeEach(() => {
    mockRunSubagentOnce.mockReset();
    mockArchiveRun.mockReset();
    mockCreateSubagentSession.mockReset();
    mockPromptSubagentSession.mockReset();
  });

  const fakeSession = () => ({ abort: vi.fn(), prompt: vi.fn() });
  const okHandle = (session: any) => ({
    session,
    model: {} as any,
    modelRef: "zai-coding-cn/glm-5.3-flash",
    requestedModel: "fast",
  });

  function residentJob(overrides: Partial<CronJob> = {}): CronJob {
    return exampleJob({
      type: "cron",
      schedule: "0 * * * * *",
      model: "fast",
      resident: true,
      notifyOn: "anomaly",
      displayOn: "anomaly",
      ...overrides,
    });
  }

  it("reuses one session across beats; the seed rides only the first beat", async () => {
    const session = fakeSession();
    mockCreateSubagentSession.mockResolvedValue({ ok: true, handle: okHandle(session) as any });
    mockPromptSubagentSession.mockResolvedValue({ ok: true, text: "STATUS: fine\nHEARTBEAT_OK" });
    const job = residentJob();
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, makePi(), makeCtx());

    await (scheduler as any).executeJobInSubagent(job);
    await (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(storage.getJob(job.id).runCount).toBe(2));

    expect(mockCreateSubagentSession).toHaveBeenCalledTimes(1);
    expect(mockPromptSubagentSession).toHaveBeenCalledTimes(2);
    const firstPrompt = mockPromptSubagentSession.mock.calls[0][1] as string;
    expect(firstPrompt).toContain("persistent background heartbeat agent");
    expect(firstPrompt).toContain(job.prompt);
    expect(firstPrompt).toContain("STATUS:");
    const secondPrompt = mockPromptSubagentSession.mock.calls[1][1] as string;
    expect(secondPrompt).not.toContain("persistent background heartbeat agent");
    expect(secondPrompt).toContain(job.prompt);
  });

  it("extracts and persists the STATUS progress line from the first non-empty line", async () => {
    const session = fakeSession();
    mockCreateSubagentSession.mockResolvedValue({ ok: true, handle: okHandle(session) as any });
    mockPromptSubagentSession.mockResolvedValue({
      ok: true,
      text: "STATUS: local 10.2M/20.5M shots | gpu 4.7GiB | eta 17:30\nHEARTBEAT_OK",
    });
    const job = residentJob();
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, makePi(), makeCtx());

    await (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(storage.getJob(job.id).lastStatus).toBe("success"));

    const updated = storage.getJob(job.id);
    expect(updated.lastStatusLine).toBe("local 10.2M/20.5M shots | gpu 4.7GiB | eta 17:30");
    expect(updated.lastStatusLineAt).toBeDefined();
  });

  it("does not treat a STATUS line deeper in the output as progress", async () => {
    mockRunSubagentOnce.mockResolvedValue({
      ok: true,
      text: "HEARTBEAT_OK\nsome quoted note: `STATUS: not a progress line`",
    });
    const job = exampleJob({ model: "haiku" });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, makePi(), makeCtx());

    await (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(storage.getJob(job.id).lastStatus).toBe("success"));
    expect(storage.getJob(job.id).lastStatusLine).toBeUndefined();
  });

  it("ask interrogates the resident session without advancing beat counters", async () => {
    const session = fakeSession();
    mockCreateSubagentSession.mockResolvedValue({ ok: true, handle: okHandle(session) as any });
    mockPromptSubagentSession.mockResolvedValue({ ok: true, text: "gpu spiked because tier 2 started" });
    const job = residentJob();
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, makePi(), makeCtx());

    const answer = await scheduler.askResident(job.id, "why did gpu spike?");

    expect(answer).toEqual({ ok: true, text: "gpu spiked because tier 2 started" });
    expect(storage.getJob(job.id).runCount).toBe(0);
    expect(mockArchiveRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      job.id,
      expect.objectContaining({ kind: "ask" }),
    );
  });

  it("ask rejects non-resident jobs and busy jobs", async () => {
    const scheduler = new CronScheduler(makeStorage([exampleJob({ id: "plain", model: "haiku" })]), makePi(), makeCtx());

    const notResident = await scheduler.askResident("plain", "hi?");
    expect(notResident.ok).toBe(false);
    expect(notResident.ok === false && notResident.error).toContain("resident");

    const job = residentJob({ id: "busyjob" });
    const scheduler2 = new CronScheduler(makeStorage([job]), makePi(), makeCtx());
    (scheduler2 as any).activeJobs.add("busyjob");
    const busy = await scheduler2.askResident("busyjob", "hi?");
    expect(busy.ok).toBe(false);
    expect(busy.ok === false && busy.error).toContain("busy");
  });

  it("suppresses repeated anomaly wakes and re-wakes on the 4th consecutive beat", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "HEARTBEAT_ALERT persists" });
    const job = exampleJob({ model: "haiku", notifyOn: "anomaly", displayOn: "always" });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, makePi(), makeCtx());

    const runOnce = async () => {
      const pi = makePi();
      (scheduler as any).pi = pi; // fresh capture per beat
      await (scheduler as any).executeJobInSubagent(storage.getJob(job.id)!);
      await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalled());
      return pi;
    };

    const wakeOpts = (pi: any) => {
      const done = pi.sendMessage.mock.calls.find((c: any[]) => c[0].details?.mode === "subagent_done");
      return done?.[1];
    };

    expect(wakeOpts(await runOnce())).toEqual({ deliverAs: "followUp", triggerTurn: true }); // streak 1
    expect(wakeOpts(await runOnce())).toBeUndefined(); // streak 2
    expect(wakeOpts(await runOnce())).toBeUndefined(); // streak 3
    expect(wakeOpts(await runOnce())).toEqual({ deliverAs: "followUp", triggerTurn: true }); // streak 4
    expect(storage.getJob(job.id).lastAlertStreak).toBe(4);
  });

  it("posts a display-only recovery marker when an anomaly clears", async () => {
    const job = exampleJob({ model: "haiku", notifyOn: "anomaly", displayOn: "always" });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, makePi(), makeCtx());

    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "HEARTBEAT_ALERT bad" });
    await (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(storage.getJob(job.id).lastOutcome).toBe("anomaly"));

    const pi = makePi();
    (scheduler as any).pi = pi;
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "HEARTBEAT_OK good" });
    await (scheduler as any).executeJobInSubagent(storage.getJob(job.id)!);
    await vi.waitFor(() => expect(storage.getJob(job.id).lastOutcome).toBe("ok"));

    const modes = pi.sendMessage.mock.calls.map((c: any[]) => c[0].details?.mode);
    expect(modes).toContain("subagent_recovered");
    const recovery = pi.sendMessage.mock.calls.find((c: any[]) => c[0].details?.mode === "subagent_recovered");
    expect(recovery?.[1]).toBeUndefined(); // display-only, never wakes
    expect(storage.getJob(job.id).lastAlertStreak).toBe(0);
  });

  it("disposes the resident session when the job config changes", async () => {
    const session = fakeSession();
    mockCreateSubagentSession.mockResolvedValue({ ok: true, handle: okHandle(session) as any });
    mockPromptSubagentSession.mockResolvedValue({ ok: true, text: "HEARTBEAT_OK" });
    const job = residentJob();
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, makePi(), makeCtx());

    await (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(storage.getJob(job.id).lastStatus).toBe("success"));

    scheduler.updateJob(job.id, { ...storage.getJob(job.id)!, prompt: "changed prompt" });
    expect(session.abort).toHaveBeenCalled();
    expect((scheduler as any).residentSessions.size).toBe(0);
  });

  it("buildParentDigest-equivalent filtering: toolResult roles are excluded from the seed", async () => {
    const ctx = makeCtx();
    (ctx.sessionManager as any).getEntries = () => [
      { type: "message", message: { role: "user", content: "run the sweep" } },
      { type: "message", message: { role: "toolResult", content: "huge tool payload 12345" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "sweep started" }] } },
    ];
    const session = fakeSession();
    mockCreateSubagentSession.mockResolvedValue({ ok: true, handle: okHandle(session) as any });
    mockPromptSubagentSession.mockResolvedValue({ ok: true, text: "STATUS: ok" });
    const job = residentJob();
    const scheduler = new CronScheduler(makeStorage([job]), makePi(), ctx);

    await (scheduler as any).executeJobInSubagent(job);

    const seed = mockPromptSubagentSession.mock.calls[0][1] as string;
    expect(seed).toContain("run the sweep");
    expect(seed).toContain("sweep started");
    expect(seed).not.toContain("huge tool payload");
  });

  it("disposes a resident session when its TTL expires (default 60m)", async () => {
    const session = fakeSession();
    mockCreateSubagentSession.mockResolvedValue({ ok: true, handle: okHandle(session) as any });
    mockPromptSubagentSession.mockResolvedValue({ ok: true, text: "STATUS: ok\nHEARTBEAT_OK" });
    const job = residentJob({ residentTtlMinutes: 60 });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, makePi(), makeCtx());

    await (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(storage.getJob(job.id).runCount).toBe(1));

    // Age the session past its TTL, then run another beat.
    (scheduler as any).residentSessions.get(job.id).createdAt = Date.now() - 61 * 60_000;
    await (scheduler as any).executeJobInSubagent(storage.getJob(job.id)!);
    await vi.waitFor(() => expect(storage.getJob(job.id).runCount).toBe(2));

    expect(session.abort).toHaveBeenCalled(); // TTL reset disposed the old session
    expect((scheduler as any).residentHandoffs.get(job.id)).toContain("session age exceeded 60 minutes");
    expect((scheduler as any).residentSessions.size).toBe(0);
  });

  it("residentTranscript returns the live dialogue; errors guide non-resident jobs to logs", async () => {
    const session = {
      abort: vi.fn(),
      messages: [
        { role: "user", content: "seed + beat prompt" },
        { role: "assistant", content: [{ type: "text", text: "STATUS: ok\nHEARTBEAT_OK" }] },
      ],
    };
    mockCreateSubagentSession.mockResolvedValue({ ok: true, handle: okHandle(session) as any });
    mockPromptSubagentSession.mockResolvedValue({ ok: true, text: "STATUS: ok\nHEARTBEAT_OK" });
    const job = residentJob();
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, makePi(), makeCtx());

    await (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(storage.getJob(job.id).lastStatus).toBe("success"));

    const view = scheduler.residentTranscript(job.id);
    expect(view.ok).toBe(true);
    if (view.ok) {
      expect(view.beats).toBe(1);
      expect(view.lines.some((l) => l.startsWith("user: "))).toBe(true);
      expect(view.lines.some((l) => l.includes("HEARTBEAT_OK"))).toBe(true);
    }

    const plain = exampleJob({ id: "plain2", model: "haiku" });
    const scheduler2 = new CronScheduler(makeStorage([plain]), makePi(), makeCtx());
    const err = scheduler2.residentTranscript("plain2");
    expect(err.ok).toBe(false);
    expect(err.ok === false && err.error).toContain('action="logs"');
  });
});

describe("CronScheduler — pi-subagents RPC runner", () => {
  beforeEach(() => {
    mockRunSubagentOnce.mockReset();
    mockArchiveRun.mockReset();
    mockCreateSubagentSession.mockReset();
    mockPromptSubagentSession.mockReset();
  });

  /** Functional mini event bus — replies SYNCHRONOUSLY inside emit(), exactly
   *  like pi's in-process event bus (see pi-subagents docs/rpc.md). */
  function makeRpcPi(opts: { agentId?: string; result?: string; fail?: boolean } = {}) {
    const agentId = opts.agentId ?? "agent-1";
    const handlers = new Map<string, ((data: any) => void)[]>();
    const spawnRequests: any[] = [];
    const dispatch = (event: string, data: any) => {
      for (const h of handlers.get(event) ?? []) h(data);
    };
    return {
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      events: {
        on: (event: string, handler: (data: any) => void) => {
          const list = handlers.get(event) ?? [];
          list.push(handler);
          handlers.set(event, list);
          return () => {
            handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
          };
        },
        emit: (event: string, data: any) => {
          // Host handlers are async wrappers — replies land on microtasks, and
          // lifecycle events strictly after the spawn reply resolves.
          if (event === "subagents:rpc:ping") {
            queueMicrotask(() => dispatch(`${event}:reply:${data.requestId}`, { success: true, version: 2 }));
            return;
          }
          if (event === "subagents:rpc:spawn") {
            spawnRequests.push(data);
            queueMicrotask(() => {
              dispatch(`${event}:reply:${data.requestId}`, { success: true, data: agentId });
              setTimeout(() => {
                if (opts.fail) {
                  dispatch("subagents:failed", { id: agentId, error: "agent exploded" });
                } else {
                  dispatch("subagents:completed", { id: agentId, result: opts.result ?? "STATUS: rpc ok\nHEARTBEAT_OK" });
                }
              }, 5);
            });
            return;
          }
          dispatch(event, data);
        },
      },
      spawnRequests,
    } as any;
  }

  it("routes non-resident beats through the RPC runner when available", async () => {
    const pi = makeRpcPi();
    const job = exampleJob({ model: "haiku", notifyOn: "anomaly", displayOn: "anomaly" });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(storage.getJob(job.id).lastStatus).toBe("success"));

    expect(mockRunSubagentOnce).not.toHaveBeenCalled();
    // The RPC host must receive the canonical model reference, not an alias.
    expect(pi.spawnRequests[0]?.options?.model).toBe("haiku");
    expect(pi.spawnRequests[0]?.prompt).toContain("STATUS:");
    expect(storage.getJob(job.id).lastOutcome).toBe("ok");
    expect(storage.getJob(job.id).lastStatusLine).toBe("rpc ok");
    expect(mockArchiveRun).toHaveBeenCalledTimes(1);
    expect(mockArchiveRun.mock.calls[0][3]).toMatchObject({ output: "STATUS: rpc ok\nHEARTBEAT_OK" });
    expect(pi.sendMessage).not.toHaveBeenCalled(); // quiet healthy beat
  });

  it("falls back to the internal runner when the RPC host is absent", async () => {
    mockRunSubagentOnce.mockResolvedValue({ ok: true, text: "STATUS: internal ok\nHEARTBEAT_OK" });
    const pi = makePi(); // events.on/emit are vi.fn()s → ping never replies
    const job = exampleJob({ model: "haiku" });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(storage.getJob(job.id).lastStatus).toBe("success"));

    expect(mockRunSubagentOnce).toHaveBeenCalledTimes(1);
    expect(storage.getJob(job.id).lastStatusLine).toBe("internal ok");
  });

  it("surfaces a failed RPC run through the error pipeline", async () => {
    const pi = makeRpcPi({ fail: true });
    const job = exampleJob({ model: "haiku", notifyOn: "anomaly", displayOn: "anomaly" });
    const storage = makeStorage([job]);
    const scheduler = new CronScheduler(storage, pi, makeCtx());

    (scheduler as any).executeJobInSubagent(job);
    await vi.waitFor(() => expect(storage.getJob(job.id).lastStatus).toBe("error"));

    expect(storage.getJob(job.id).lastOutcome).toBe("error");
    expect(mockArchiveRun.mock.calls[0][3]).toMatchObject({ outcome: "error", error: "agent exploded" });
  });
});
