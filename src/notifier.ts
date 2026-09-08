import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskRegistry } from "./registry.js";
import type { TaskSummary } from "./types.js";

export interface CompletionMessageDetails {
  tasks: Array<Pick<TaskSummary, "taskId" | "name" | "status" | "exitCode" | "logPath">>;
}

export class CompletionNotifier {
  private readonly pending = new Map<string, TaskSummary>();
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;
  private readonly onCompletion = (task: TaskSummary) => {
    this.pending.set(task.taskId, task);
    this.timer ??= setTimeout(() => void this.flush(), 150);
  };

  constructor(private readonly pi: ExtensionAPI, private readonly registry: TaskRegistry) {
    registry.on("completion", this.onCompletion);
  }

  async enqueueVisiblePending(): Promise<void> {
    for (const task of await this.registry.visiblePendingCompletions()) this.pending.set(task.taskId, task);
    if (this.pending.size > 0) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed) return;
    const candidates = [...this.pending.values()];
    this.pending.clear();
    const tasks: TaskSummary[] = [];
    for (const task of candidates) {
      if (await this.registry.shouldNotify(task.taskId)) tasks.push(task);
    }
    if (tasks.length === 0) return;
    const lines = tasks.map((task) =>
      `- ${task.taskId} (${task.name}): ${task.status}${task.exitCode === null ? "" : `, exit ${task.exitCode}`}`,
    );
    this.pi.sendMessage<CompletionMessageDetails>(
      {
        customType: "pi-background-task:completion",
        content: `Background task completion:\n${lines.join("\n")}\nUse task_logs if output is needed.`,
        display: true,
        details: {
          tasks: tasks.map(({ taskId, name, status, exitCode, logPath }) => ({ taskId, name, status, exitCode, logPath })),
        },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    await this.registry.markNotified(tasks.map((task) => task.taskId));
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.registry.off("completion", this.onCompletion);
  }
}
