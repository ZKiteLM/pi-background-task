import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { CompletionNotifier, type CompletionMessageDetails } from "./notifier.js";
import { TaskRegistry } from "./registry.js";
import { registerTools } from "./tools.js";
import { type CommandOutputEntry, TaskDashboard, colorStatus } from "./tui.js";
import { isTerminalStatus } from "./types.js";
import { newInstanceId } from "./utils.js";

const GLOBAL_KEY = Symbol.for("pi-background-task.instance-id");

function processInstanceId(): string {
  const globalState = globalThis as typeof globalThis & { [GLOBAL_KEY]?: string };
  globalState[GLOBAL_KEY] ??= newInstanceId();
  return globalState[GLOBAL_KEY];
}

export function branchTaskIds(sessionManager: { getBranch(): Array<{ type: string; message?: unknown }> }): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message as { role?: string; toolName?: string; details?: unknown };
    if (message.role !== "toolResult" || message.toolName !== "task_start") continue;
    const details = message.details;
    if (!details || typeof details !== "object") continue;
    const taskId = (details as { taskId?: unknown }).taskId;
    if (typeof taskId === "string") ids.add(taskId);
  }
  return ids;
}

export default function backgroundTaskExtension(pi: ExtensionAPI): void {
  let registry: TaskRegistry | undefined;
  let notifier: CompletionNotifier | undefined;
  const runnerPath = fileURLToPath(new URL("./runner.js", import.meta.url));

  const requireRegistry = (): TaskRegistry => {
    if (!registry) throw new Error("Background task runtime is not initialized");
    return registry;
  };

  registerTools(pi, requireRegistry);

  pi.registerMessageRenderer<CompletionMessageDetails>("pi-background-task:completion", (message, _options, theme) => {
    const tasks = message.details?.tasks ?? [];
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("accent", theme.bold("Background tasks finished")), 0, 0));
    for (const task of tasks) box.addChild(new Text(`${colorStatus(theme, task.status, task.status)} ${theme.fg("muted", task.name)} ${theme.fg("dim", task.taskId)}`, 0, 0));
    return box;
  });

  pi.registerEntryRenderer<CommandOutputEntry>("pi-background-task:output", (entry, _options, theme) => {
    const data = entry.data;
    if (!data) return undefined;
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("accent", theme.bold(data.title)), 0, 0));
    box.addChild(new Text(theme.fg("muted", data.body), 0, 0));
    return box;
  });

  pi.registerCommand("bg-tasks", {
    description: "Open tasks referenced by the current session branch; pass 'all' for project history",
    handler: async (args, ctx) => {
      const includeHistory = args.trim() === "all" || args.trim() === "--all";
      const current = requireRegistry();
      if (ctx.mode !== "tui") {
        const tasks = await current.list(includeHistory ? "all" : "session");
        pi.appendEntry<CommandOutputEntry>("pi-background-task:output", {
          title: "Background Tasks",
          body: tasks.length ? tasks.map((task) => `${task.status.padEnd(11)} ${task.taskId} ${task.name}`).join("\n") : "No background tasks.",
          timestamp: Date.now(),
        });
        return;
      }
      let dashboard: TaskDashboard | undefined;
      try {
        await ctx.ui.custom<void>(async (tui, theme, _kb, done) => {
          dashboard = new TaskDashboard(current, theme, () => tui.requestRender(), () => done(), includeHistory);
          await dashboard.initialize();
          return dashboard;
        });
      } finally {
        dashboard?.dispose();
      }
    },
  });

  pi.registerCommand("bg-attach", {
    description: "Show the tmux attach command for a running background task",
    handler: async (args, ctx) => {
      const taskId = args.trim();
      if (!taskId) {
        ctx.ui.notify("Usage: /bg-attach <taskId>", "warning");
        return;
      }
      const task = await requireRegistry().get(taskId);
      if (!task.ownedByCurrentInstance) throw new Error("Cannot attach to a task owned by another Pi instance");
      if (!task.attachCommand) throw new Error(`Task is not running: ${taskId}`);
      pi.appendEntry<CommandOutputEntry>("pi-background-task:output", {
        title: `Attach ${task.name}`,
        body: task.attachCommand,
        timestamp: Date.now(),
      });
    },
  });

  pi.registerCommand("bg-clear", {
    description: "Delete finished task records visible on the current session branch",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) throw new Error("/bg-clear requires an interactive UI so deletion can be confirmed");
      const finished = (await requireRegistry().list("session")).filter((task) => isTerminalStatus(task.status));
      if (finished.length === 0) {
        ctx.ui.notify("No finished background tasks to clear", "info");
        return;
      }
      if (ctx.hasUI && !(await ctx.ui.confirm("Clear background task history?", `Delete ${finished.length} finished task record(s) and logs?`))) return;
      const count = await requireRegistry().clearFinished();
      ctx.ui.notify(`Cleared ${count} background task record(s)`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    notifier?.dispose();
    registry?.dispose();
    registry = new TaskRegistry(
      ctx.cwd,
      processInstanceId(),
      runnerPath,
      ctx.sessionManager.getSessionId(),
      () => branchTaskIds(ctx.sessionManager),
    );
    notifier = new CompletionNotifier(pi, registry);
    try {
      await registry.initialize();
      await notifier.enqueueVisiblePending();
    } catch (error) {
      notifier.dispose();
      notifier = undefined;
      registry.dispose();
      registry = undefined;
      throw error;
    }
    if (ctx.hasUI) {
      const updateStatus = async () => {
        const count = (await registry?.list("session") ?? []).filter((task) => task.status === "running" || task.status === "starting").length;
        ctx.ui.setStatus("pi-background-task", count ? `${count} bg task${count === 1 ? "" : "s"}` : undefined);
      };
      await updateStatus();
      registry.on("changed", () => void updateStatus());
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    registry?.refreshBranchScope();
    if (ctx.hasUI) {
      const count = (await registry?.list("session") ?? []).filter((task) => task.status === "running" || task.status === "starting").length;
      ctx.ui.setStatus("pi-background-task", count ? `${count} bg task${count === 1 ? "" : "s"}` : undefined);
    }
    await notifier?.enqueueVisiblePending();
  });

  pi.on("session_shutdown", async (event, ctx) => {
    notifier?.dispose();
    notifier = undefined;
    const current = registry;
    registry = undefined;
    if (current) await current.shutdown(event.reason === "quit");
    if (ctx.hasUI) ctx.ui.setStatus("pi-background-task", undefined);
  });
}
