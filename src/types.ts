import { type Static, StringEnum, Type } from "@earendil-works/pi-ai";

/**
 * Type of cron job
 */
export type CronJobType = "cron" | "once" | "interval";

/**
 * Status of the last job execution
 */
export type CronJobStatus = "success" | "error" | "running";

/** How a background job wakes its parent session. */
export type NotifyMode = "always" | "never" | "anomaly";

/** How a background job renders its run markers in the parent chat. */
export type DisplayMode = "always" | "anomaly" | "never";

/**
 * A scheduled cron job
 */
export interface CronJob {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Cron expression, ISO timestamp, or interval description */
  schedule: string;
  /** The prompt to execute */
  prompt: string;
  /** Whether the job is enabled */
  enabled: boolean;
  /** Type of job */
  type: CronJobType;
  /** Interval in milliseconds (for interval type) */
  intervalMs?: number;
  /** When the job was created */
  createdAt: string;
  /** Last execution timestamp */
  lastRun?: string;
  /** Status of last execution */
  lastStatus?: CronJobStatus;
  /** Next scheduled run (computed) */
  nextRun?: string;
  /** Number of times executed */
  runCount: number;
  /** Optional description */
  description?: string;
  /** If set, run the prompt in a separate in-process agent session using this model instead of injecting into the current chat. */
  model?: string;
  /** Subagent jobs only. Legacy switch: true wakes the parent after every run. */
  notify?: boolean;
  /** Subagent jobs only. Prefer `anomaly` for recurring health checks to avoid waking the parent when healthy. */
  notifyOn?: NotifyMode;
  /** Subagent jobs only. Chat-display policy for run markers, orthogonal to `notifyOn` (wake). `anomaly` keeps healthy runs fully silent — no chat rows, no parent-context growth — with outputs archived on disk (see action="logs"). Default `always` (legacy behavior). */
  displayOn?: DisplayMode;
  /** Subagent jobs only. Keep one agent session alive across fires instead of a fresh session per tick — gives the heartbeat trend memory — and allow ad-hoc `action="ask"` interrogation. Requires `model`. */
  resident?: boolean;
  /** Optional briefing embedded once when a resident session is created (or re-seeded after a reset). */
  contextNote?: string;
  /** Outcome of the last subagent run: healthy, anomalous-but-successful, or failed. */
  lastOutcome?: "ok" | "anomaly" | "error";
  /** Last `STATUS:` line extracted from a subagent run's output (progress convention, see README). */
  lastStatusLine?: string;
  /** When `lastStatusLine` was captured — staleness signal for the compact widget. */
  lastStatusLineAt?: string;
  /** Consecutive anomalous-but-successful runs; drives wake suppression so a persistent anomaly does not wake the parent every tick. */
  lastAlertStreak?: number;
  /** Subagent jobs only. Disable a recurring job after a successful result containing this literal marker. */
  stopOn?: string;
  /** Subagent jobs only. If true, loads all registered extensions. If an array of package names, only those extensions. Default undefined (none). */
  extensions?: boolean | string[];
  /** Subagent jobs only. If true, loads all skills. If an array of skill names, only those skills. Default undefined (none). */
  skills?: boolean | string[];
  /** Session id this job is bound to. When absent, every pi in the cwd loads it. */
  session?: string;
}

/**
 * Persistent storage for cron jobs
 */
export interface CronStore {
  jobs: CronJob[];
  version: number;
}

/**
 * Tool result details for LLM context
 */
export interface CronToolDetails {
  action: string;
  jobs: CronJob[];
  error?: string;
  jobId?: string;
  jobName?: string;
}

/**
 * Tool parameter schema
 */
export const CronToolParams = Type.Object({
  action: StringEnum(["add", "remove", "list", "enable", "disable", "update", "cleanup", "logs", "ask"], {
    description: "Action to perform",
  }),
  name: Type.Optional(
    Type.String({
      description: "Job name, auto-generated if omitted",
    })
  ),
  schedule: Type.Optional(
    Type.String({
      description:
        "Required for add. Cron expression, ISO timestamp, relative time (+10s, +5m), or interval string",
    })
  ),
  prompt: Type.Optional(
    Type.String({
      description: "Required for add. The prompt text to execute",
    })
  ),
  jobId: Type.Optional(
    Type.String({
      description: "Job ID for remove, enable, disable, or update actions",
    })
  ),
  type: Type.Optional(
    StringEnum(["cron", "once", "interval"], {
      description: "Job type. Use 'once' for relative times like '+10s'. Default is cron",
    })
  ),
  description: Type.Optional(
    Type.String({
      description: "Optional job description",
    })
  ),
  model: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Optional. If set, runs the prompt in a separate in-process agent session using this model (e.g. 'haiku', 'sonnet', or 'provider/model-id'). If omitted, the prompt is injected into the current chat. Must be a non-empty string — to switch a job from subagent back to inline mode, remove the job and re-add it without a model.",
    })
  ),
  notify: Type.Optional(
    Type.Boolean({
      description:
        "Legacy subagent switch. If true, wake the parent after every run. For recurring health checks prefer notifyOn='anomaly'.",
    })
  ),
  notifyOn: Type.Optional(
    StringEnum(["always", "never", "anomaly"], {
      description:
        "Subagent notification policy: always, never, or anomaly (wake only when output contains HEARTBEAT_ALERT/ALERT/ERROR/FAILED/OOM/DEAD/UNREACHABLE/BLOCKED).",
    })
  ),
  displayOn: Type.Optional(
    StringEnum(["always", "anomaly", "never"], {
      description:
        "Subagent jobs only. Chat-display policy for run markers, orthogonal to notifyOn (wake): always (default), anomaly (healthy runs post nothing to chat or model context; outputs archived on disk, read via action='logs'), or never (no markers rendered; wake per notifyOn still applies).",
    })
  ),
  resident: Type.Optional(
    Type.Boolean({
      description:
        "Subagent jobs only (requires model). Keep one agent session alive across fires — the heartbeat remembers previous beats and trends — and enable action='ask' to interrogate it ad hoc. The session resets automatically when its transcript grows too large, carrying a handoff summary.",
    })
  ),
  contextNote: Type.Optional(
    Type.String({
      description:
        "Subagent jobs only. Briefing text embedded once when a resident session is created: background the heartbeat agent should always know (experiment layout, what the arms mean, alert thresholds). Bounded to ~4k chars.",
    })
  ),
  question: Type.Optional(
    Type.String({
      minLength: 1,
      description: "action='ask' only. Ad-hoc question sent into a resident job's session; its full answer is returned. The job must have resident=true.",
    })
  ),
  tail: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 50,
      description: "Action='logs' only. Number of archived runs to return, newest first (default 5).",
    })
  ),
  stopOn: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Subagent jobs only. Disable a recurring job after a successful result contains this literal completion marker.",
    })
  ),
  extensions: Type.Optional(
    Type.Union([
      Type.Boolean({
        description: "If true, loads all registered extensions.",
      }),
      Type.Array(Type.String(), {
        description: "List of extension package names to load.",
      }),
    ])
  ),
  skills: Type.Optional(
    Type.Union([
      Type.Boolean({
        description: "If true, loads all skills.",
      }),
      Type.Array(Type.String(), {
        description: "List of skill names to load.",
      }),
    ])
  ),
});

export type CronToolParamsType = Static<typeof CronToolParams>;

/**
 * Event emitted when a job is added, removed, or updated
 */
export interface CronChangeEvent {
  type: "add" | "remove" | "update" | "fire" | "error";
  job?: CronJob;
  jobId?: string;
  error?: string;
}
