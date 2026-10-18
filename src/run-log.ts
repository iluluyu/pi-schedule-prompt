// Bounded on-disk archive of scheduled subagent runs.
//
// Quiet jobs (displayOn "anomaly"/"never") post nothing to the parent chat;
// their outputs live here instead so `schedule_prompt action="logs"` can
// retrieve them on demand. One JSONL file per job, namespaced by a hash of
// the canonical cwd so two projects never share a log.

import { createHash } from "node:crypto";
import * as fs from "fs";
import * as path from "path";

/** Max runs retained per job file. */
const MAX_RUNS = 50;
/** Max bytes per job file before a trim rewrite. */
const MAX_BYTES = 1024 * 1024;
/** Max characters of output/error stored per run. */
const MAX_OUTPUT_CHARS = 8192;
/** Max runs returned by a single readRuns call. */
const MAX_TAIL = 50;

export type RunOutcome = "ok" | "anomaly" | "error";

export interface RunLogEntry {
  ts: string;
  outcome: RunOutcome;
  /** What produced this entry: a scheduled beat (default) or an ad-hoc ask. */
  kind?: "beat" | "ask";
  model?: string;
  requestedModel?: string;
  durationMs?: number;
  output?: string;
  error?: string;
  /** Set when output/error was truncated to MAX_OUTPUT_CHARS. */
  truncated?: boolean;
  originalLength?: number;
}

function cap(text: string): { text: string; truncated?: boolean; originalLength?: number } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text };
  return { text: text.slice(0, MAX_OUTPUT_CHARS), truncated: true, originalLength: text.length };
}

/** Hashed directory name for a cwd — stable across sessions, collision-safe. */
function dirName(baseDir: string, cwd: string): string {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return path.join(baseDir, hash);
}

/** Pure path computation — never creates directories. */
export function runLogPath(baseDir: string, cwd: string, jobId: string): string {
  return path.join(dirName(baseDir, cwd), `${jobId}.jsonl`);
}

/** Ensure the hashed dir exists and carries a human-readable cwd marker. */
function ensureDir(baseDir: string, cwd: string): string {
  const dir = dirName(baseDir, cwd);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "cwd.txt"), `${cwd}\n`, "utf-8");
  } catch (err) {
    console.warn(`[pi-schedule-prompt] run-log dir setup failed for ${cwd}:`, err);
  }
  return dir;
}

/** Append one run. Best-effort and never throws — an archive failure must
 *  not mask an execution success/failure. Trims the file back to MAX_RUNS
 *  lines / MAX_BYTES after appending. */
export function archiveRun(baseDir: string, cwd: string, jobId: string, entry: RunLogEntry): void {
  try {
    const dir = ensureDir(baseDir, cwd);
    const file = path.join(dir, `${jobId}.jsonl`);

    const record: RunLogEntry = { ...entry };
    if (entry.output !== undefined) {
      const capped = cap(entry.output);
      record.output = capped.text;
      if (capped.truncated) {
        record.truncated = true;
        record.originalLength = capped.originalLength;
      }
    } else if (entry.error !== undefined) {
      const capped = cap(entry.error);
      record.error = capped.text;
      if (capped.truncated) {
        record.truncated = true;
        record.originalLength = capped.originalLength;
      }
    }

    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf-8");

    const raw = fs.readFileSync(file, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length > MAX_RUNS || Buffer.byteLength(raw, "utf-8") > MAX_BYTES) {
      const kept = lines.slice(-MAX_RUNS);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, `${kept.join("\n")}\n`, "utf-8");
      fs.renameSync(tmp, file);
    }
  } catch (err) {
    console.warn(`[pi-schedule-prompt] failed to archive run for job ${jobId}:`, err);
  }
}

/** Read the newest archived runs for a job, newest first. Corrupt lines are
 *  skipped; a missing file yields []. */
export function readRuns(baseDir: string, cwd: string, jobId: string, tail = 5): RunLogEntry[] {
  const file = runLogPath(baseDir, cwd, jobId);
  try {
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
    const entries: RunLogEntry[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as RunLogEntry;
        if (parsed && typeof parsed.ts === "string" && typeof parsed.outcome === "string") {
          entries.push(parsed);
        }
      } catch {
        // skip corrupt line
      }
    }
    const limit = Math.min(Math.max(Math.trunc(tail) || 1, 1), MAX_TAIL);
    return entries.slice(-limit).reverse();
  } catch (err) {
    console.warn(`[pi-schedule-prompt] failed to read run log for job ${jobId}:`, err);
    return [];
  }
}
