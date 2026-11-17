import { type Static, Type } from "typebox";

/**
 * String enum as `{ type: "string", enum: [...] }` (Google-compatible; a union of
 * literals would emit `anyOf`). Same implementation as the `StringEnum` pi's
 * extension view of pi-ai provides at runtime; defined locally because pi-ai's
 * own export (>=1.5) returns a pi-schema type that TypeBox's `Static` can't infer.
 */
function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default }),
  });
}

/**
 * Type of cron job
 */
export type CronJobType = "cron" | "once" | "interval" | "idle";

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
  /** Duration in milliseconds: the period for `interval`, the idle threshold for `idle` */
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
  /** If set, run the prompt in a separate in-process session under this model when the job fires, instead of injecting it into the current chat. */
  model?: string;
  /** Subagent jobs only. Legacy switch: true wakes the parent after every run. */
  notify?: boolean;
  /** Subagent jobs only. Prefer `anomaly` for recurring health checks to avoid waking the parent when healthy. */
  notifyOn?: NotifyMode;
  /** Subagent jobs only. Chat-display policy for run markers, orthogonal to `notifyOn` (wake). `anomaly` keeps healthy runs fully silent — no chat rows, no parent-context growth — with outputs archived on disk (see action="logs"). Default `always` (legacy behavior). */
  displayOn?: DisplayMode;
  /** Subagent jobs only. Keep one agent session alive across fires instead of a fresh session per tick — gives the heartbeat trend memory — and allow ad-hoc `action="ask"` interrogation. Requires `model`. */
  resident?: boolean;
  /** Subagent jobs only. Minutes a resident session may live before it is disposed and re-seeded (with a handoff summary) on the next beat. Bounds memory drift and token spend; 0 disables the time bound (the ~120k-char transcript bound still applies). Default 60. */
  residentTtlMinutes?: number;
  /** Subagent jobs only. pi-subagents agent type used for RPC-spawned beats (default "general-purpose"). Ignored by the in-process fallback and resident mode. */
  agentType?: string;
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
  /** Cross-window claim for shared jobs: when this session last fired the
   *  beat (ISO). Other sessions skip while the claim is fresh. */
  lastClaimAt?: string;
  /** Session id that wrote lastClaimAt. */
  lastClaimSession?: string;
  /** Subagent jobs only. If true, loads all registered extensions. If an array of package names, only those extensions. Default undefined (none). */
  extensions?: boolean | string[];
  /** Only for jobs with `model` set. If true, loads all skills. If an array of skill names, only those skills. Default undefined (none). */
  skills?: boolean | string[];
  /** Session id this job is bound to. When absent, every pi in the cwd loads it. */
  session?: string;
}

/**
 * Persistent storage for cron jobs
 */
export interface CronStore {
  /** Canonical project path the store belongs to. Informational; the file name is the key. */
  cwd?: string;
  /** Set once the project's legacy `<cwd>/.pi/schedule-prompts.json` has been imported. */
  legacyImported?: boolean;
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
  action: StringEnum(["add", "remove", "list", "enable", "disable", "update", "cleanup", "logs", "ask", "transcript"], {
    description: "Action to perform. 'cleanup' deletes every disabled job.",
  }),
  name: Type.Optional(
    Type.String({
      description: "Job name, unique among jobs. Auto-generated if omitted.",
    })
  ),
  schedule: Type.Optional(
    Type.String({
      description:
        "Required for add. Format depends on 'type': cron = 6 fields 'sec min hour day month weekday' in local time ('0 */5 * * * *' = every 5 minutes); once = relative '+N' plus s/m/h/d ('+10m', '+2h') or an ISO timestamp at least 5s in the future; interval/idle = N plus s/m/h/d ('30s', '1h'), max 24d. On update, the new schedule must fit the job's existing type.",
    })
  ),
  prompt: Type.Optional(
    Type.String({
      description:
        "Required for add. The instruction to run when the job fires. Without 'model' it arrives in this chat as a user message, so write it as an instruction to yourself. With 'model' it is the whole task for a session that has no chat history, so include every detail it needs.",
    })
  ),
  jobId: Type.Optional(
    Type.String({
      description: "Job ID from the add or list output. Required for remove, enable, disable and update.",
    })
  ),
  type: Type.Optional(
    StringEnum(["cron", "once", "interval", "idle"], {
      description:
        "Job type; must match the schedule's format. 'cron' (default): recurring, 6-field cron. 'once': a single run at a relative ('+10s') or ISO time. 'interval': repeats every duration ('5m'). 'idle': fires once after the user has been inactive for the duration ('10m') and your current turn has finished; it re-arms only after new user activity. Cannot be changed by update.",
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
        "Optional. When the job fires, run its prompt in a separate session under this model (e.g. 'haiku', 'sonnet', or 'provider/model-id') instead of sending it to this chat. That session works in the same directory with bash/read/edit/write/grep/find/ls, but cannot see this conversation; a snippet of its reply is posted to this chat. Must be a non-empty string; to switch a job back to inline, remove and re-add it without 'model'.",
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
        "Subagent jobs only (requires model). Keep one agent session alive across fires — the heartbeat remembers previous beats and trends — and enable action='ask' to interrogate it ad hoc. Short-lived by default: the session is disposed and re-seeded with a handoff after residentTtlMinutes (default 60) or ~120k transcript chars, whichever comes first. Without resident, each beat spawns a fresh visible subagent (via the pi-subagents extension when present) whose trend context is fed from the run archive.",
    })
  ),
  residentTtlMinutes: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 10080,
      description: "Subagent jobs only. Resident session lifetime in minutes before dispose-and-reseed with a handoff (default 60; 0 = chars bound only).",
    })
  ),
  agentType: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Subagent jobs only. pi-subagents agent type for RPC-spawned beats (default 'general-purpose'). Set when your pi-subagents config disables the default type or provides a specialized one.",
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
      description: "Action='logs'/'transcript' only. Number of archived runs (logs, default 5) or recent dialogue messages (transcript, default 20) to return, newest last.",
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
        description:
          "Only for jobs with 'model' set. If true, the separate session loads all registered extensions and the full builtin toolset.",
      }),
      Type.Array(Type.String(), {
        description:
          "Only for jobs with 'model' set. The separate session loads only these extension package names, plus the full builtin toolset.",
      }),
    ])
  ),
  skills: Type.Optional(
    Type.Union([
      Type.Boolean({
        description: "Only for jobs with 'model' set. If true, the separate session loads all skills.",
      }),
      Type.Array(Type.String(), {
        description: "Only for jobs with 'model' set. The separate session loads only these skill names.",
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
