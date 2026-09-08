export const TASK_SCHEMA_VERSION = 1 as const;

export const TASK_STATUSES = [
  "starting",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
  "unknown",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TerminalTaskStatus = Exclude<TaskStatus, "starting" | "running" | "unknown">;
export type CancellationReason = "cancelled" | "timed_out" | "quit";

export interface TaskMeta {
  schemaVersion: typeof TASK_SCHEMA_VERSION;
  taskId: string;
  ownerInstanceId: string;
  /** Pi conversation identity. Stable across process restart + resume. */
  piSessionId?: string;
  piSessionName?: string;
  /** New tasks are visible when their task_start result is on the active branch. */
  visibilityScope?: "session-tree";
  sessionName: string;
  socketName: string;
  name: string;
  command: string;
  cwd: string;
  shell: string;
  status: "starting" | "running";
  createdAt: string;
  startedAt?: string;
  timeoutSeconds?: number;
  notifyOnCompletion: boolean;
  notifiedAt?: string;
}

export interface TaskResult {
  schemaVersion: typeof TASK_SCHEMA_VERSION;
  taskId: string;
  status: TerminalTaskStatus;
  exitCode: number | null;
  signal: string | null;
  startedAt?: string;
  endedAt: string;
  reason?: string;
}

export interface CancellationRequest {
  reason: CancellationReason;
  requestedAt: string;
}

export interface TaskSummary {
  taskId: string;
  name: string;
  command: string;
  cwd: string;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  ownerInstanceId: string;
  piSessionId?: string;
  piSessionName?: string;
  socketName: string;
  ownedByCurrentInstance: boolean;
  sessionName: string;
  logPath: string;
  attachCommand?: string;
  reason?: string;
}

export interface LogChunk {
  taskId: string;
  source: "log" | "screen";
  text: string;
  offset: number;
  nextOffset: number;
  endOfLog: boolean;
  truncated: boolean;
}

export interface WaitResult {
  mode: "any" | "all";
  completed: TaskSummary[];
  pending: string[];
  timedOut: boolean;
}

export interface TaskPaths {
  dir: string;
  meta: string;
  log: string;
  result: string;
  gate: string;
  cancel: string;
}

export function isTerminalStatus(status: TaskStatus): status is TerminalTaskStatus {
  return !["starting", "running", "unknown"].includes(status);
}
