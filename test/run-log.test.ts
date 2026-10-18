import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { archiveRun, readRuns, runLogPath } from "../src/run-log.js";

const dirs: string[] = [];

function base(): string {
  const dir = mkdtempSync(join(tmpdir(), "runlog-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function entry(i: number, output = `run ${i}`) {
  return { ts: `2026-10-18T10:${String(i).padStart(2, "0")}:00Z`, outcome: "ok" as const, output };
}

describe("run-log", () => {
  it("archives and reads back runs, newest first", () => {
    const b = base();
    for (let i = 0; i < 3; i++) archiveRun(b, "/proj", "job-1", entry(i));

    const runs = readRuns(b, "/proj", "job-1", 2);
    expect(runs).toHaveLength(2);
    expect(runs[0].ts > runs[1].ts).toBe(true); // newest first
    expect(runs[0].output).toBe("run 2");
  });

  it("caps stored output at 8192 chars with truncation metadata", () => {
    const b = base();
    archiveRun(b, "/proj", "job-1", { ts: "t", outcome: "ok", output: "y".repeat(10000) });

    const [run] = readRuns(b, "/proj", "job-1", 5);
    expect(run.output).toHaveLength(8192);
    expect(run.truncated).toBe(true);
    expect(run.originalLength).toBe(10000);
  });

  it("rotates to the last 50 runs", () => {
    const b = base();
    for (let i = 0; i < 65; i++) archiveRun(b, "/proj", "job-1", entry(i));

    const runs = readRuns(b, "/proj", "job-1", 50);
    expect(runs).toHaveLength(50);
    expect(runs[0].output).toBe("run 64"); // newest first
    expect(runs[runs.length - 1].output).toBe("run 15"); // runs 0..14 were trimmed

    const lines = readFileSync(runLogPath(b, "/proj", "job-1"), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(50);
    expect(JSON.parse(lines[0]).output).toBe("run 15");
  });

  it("namespaces logs per cwd", () => {
    const b = base();
    archiveRun(b, "/proj-a", "job-1", entry(0));
    archiveRun(b, "/proj-b", "job-1", entry(1));

    expect(runLogPath(b, "/proj-a", "job-1")).not.toBe(runLogPath(b, "/proj-b", "job-1"));
    expect(readRuns(b, "/proj-a", "job-1", 5)).toHaveLength(1);
  });

  it("returns [] for missing files", () => {
    const b = base();
    expect(readRuns(b, "/nope", "job-x", 5)).toEqual([]);
  });

  it("writes a human-readable cwd marker next to the hashed dir", () => {
    const b = base();
    archiveRun(b, "/proj", "job-1", entry(0));
    const dir = runLogPath(b, "/proj", "job-1");
    expect(readFileSync(join(dir, "..", "cwd.txt"), "utf-8")).toBe("/proj\n");
  });
});
