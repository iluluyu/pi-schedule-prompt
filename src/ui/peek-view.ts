/**
 * PeekView — read-only overlay over a job's archived heartbeat runs.
 * Escape returns to the Jobs overlay; live conversation + steering stay in
 * pi-subagents' `/agents` (this view is deliberately NOT an entry into the
 * agent session — minimal interference with the main window).
 */

import type { Component } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import type { RunLogEntry } from "../run-log.js";

const MAX_RENDER_LINES = 40;

function clip(s: string, n: number): string {
  return s.length > n ? `${s.substring(0, Math.max(0, n - 1))}…` : s;
}

function localTs(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
}

export class PeekView implements Component {
  constructor(
    private theme: any,
    private jobName: string,
    private runs: RunLogEntry[],
    private done: () => void,
  ) {}

  invalidate(): void {
    // No cached render output.
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "enter")) {
      this.done();
    }
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const rule = this.theme.fg("dim", "─".repeat(Math.max(1, width)));

    lines.push(rule);
    lines.push(
      ` ${this.theme.fg("accent", this.theme.bold(`Peek: ${this.jobName}`))}  ${this.theme.fg("dim", ` ${this.runs.length} archived run(s) · esc back · live view + steer: /agents`)}`,
    );
    lines.push(rule);

    if (this.runs.length === 0) {
      lines.push("");
      lines.push("  No archived runs yet — the first beat's output will appear here.");
      lines.push(rule);
      return lines;
    }

    // Newest first.
    for (const run of [...this.runs].reverse()) {
      if (lines.length >= MAX_RENDER_LINES) {
        lines.push(this.theme.fg("dim", "  … older runs omitted"));
        break;
      }
      const icon =
        run.outcome === "ok"
          ? this.theme.fg("success", "✓")
          : run.outcome === "anomaly"
            ? this.theme.fg("warning", "⚠")
            : this.theme.fg("error", "!");
      const kind = run.kind === "ask" ? "ask" : "beat";
      const model = run.model ? this.theme.fg("dim", ` ${run.model}`) : "";
      lines.push(`  ${icon} ${this.theme.fg("dim", localTs(run.ts))} ${kind}${model}`);

      const body = (run.error ?? run.output ?? "").trim();
      const bodyLines = body ? body.split("\n").filter((l) => l.trim().length > 0) : [];
      const shown = bodyLines.slice(0, 2);
      for (const l of shown) {
        lines.push(this.theme.fg("dim", `      ${clip(l, Math.max(8, width - 8))}`));
      }
      if (run.truncated || bodyLines.length > 2) {
        lines.push(this.theme.fg("dim", `      (+${Math.max(bodyLines.length - 2, 0)} more lines${run.truncated ? ", archived output truncated" : ""})`));
      }
      if (!shown.length) {
        lines.push(this.theme.fg("dim", "      (no output)"));
      }
    }

    lines.push(rule);
    return lines;
  }
}
