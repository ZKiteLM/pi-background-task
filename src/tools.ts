import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { TaskRegistry } from "./registry.js";
import { renderToolResult } from "./tui.js";
import { resolveWorkingDirectory } from "./utils.js";

type RegistryProvider = () => TaskRegistry;

export function registerTools(pi: ExtensionAPI, registry: RegistryProvider): void {
  pi.registerTool({
    name: "task_start",
    label: "Background Task",
    description: "Start a shell command in a persistent tmux-backed background terminal and return immediately with its task ID.",
    promptSnippet: "Start a command in a persistent tmux-backed background terminal",
    promptGuidelines: ["Use task_logs with bounded offsets instead of repeatedly requesting full task output."],
    parameters: Type.Object({
      command: Type.String({ minLength: 1, maxLength: 32_768, description: "Shell command to run" }),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
      cwd: Type.Optional(Type.String({ description: "Absolute path or path relative to Pi's cwd" })),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 604_800 })),
      notifyOnCompletion: Type.Optional(Type.Boolean({ default: true })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const cwd = await resolveWorkingDirectory(params.cwd, ctx.cwd);
      const task = await registry().start({
        command: params.command,
        cwd,
        ...(params.name ? { name: params.name } : {}),
        ...(params.timeoutSeconds !== undefined ? { timeoutSeconds: params.timeoutSeconds } : {}),
        ...(params.notifyOnCompletion !== undefined ? { notifyOnCompletion: params.notifyOnCompletion } : {}),
      });
      return { content: [{ type: "text", text: `Started ${task.taskId} (${task.name}); status: ${task.status}.` }], details: task };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("background"))} ${theme.fg("muted", args.name || args.command)}`, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      return renderSummaryOrText(result, theme, expanded);
    },
  });

  pi.registerTool({
    name: "task_status",
    label: "Task Status",
    description: "Inspect status, runtime, exit code, ownership, and paths for background tasks.",
    promptSnippet: "Inspect one or more background tasks",
    executionMode: "parallel",
    parameters: Type.Object({ taskIds: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })) }),
    async execute(_id, params) {
      const tasks = params.taskIds?.length
        ? await Promise.all(params.taskIds.map((taskId) => registry().get(taskId)))
        : await registry().list("session");
      return { content: [{ type: "text", text: taskListText(tasks) }], details: { tasks } };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("task status"))} ${theme.fg("dim", args.taskIds?.join(", ") || "current branch")}`, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as { tasks?: Array<ReturnTypeShape> } | undefined;
      if (!details?.tasks) return textResult(result, theme);
      const shown = expanded ? details.tasks : details.tasks.slice(0, 5);
      const text = shown.map((task) => `${task.status.padEnd(11)} ${task.taskId}  ${task.name}`).join("\n") || "No tasks";
      return new Text(theme.fg("muted", text), 0, 0);
    },
  });

  pi.registerTool({
    name: "task_logs",
    label: "Task Logs",
    description: "Read a bounded byte range from a task log or capture the current live terminal screen.",
    promptSnippet: "Read a bounded chunk of persisted output or the live terminal screen",
    executionMode: "parallel",
    parameters: Type.Object({
      taskId: Type.String(),
      source: Type.Optional(StringEnum(["log", "screen"] as const, { default: "log" })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limitBytes: Type.Optional(Type.Integer({ minimum: 4, maximum: 65_536 })),
      screenLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
      stripAnsi: Type.Optional(Type.Boolean({ default: true })),
    }),
    async execute(_id, params) {
      const strip = params.stripAnsi ?? true;
      const chunk = params.source === "screen"
        ? await registry().screen(params.taskId, params.screenLines, strip)
        : await registry().logs(params.taskId, params.offset, params.limitBytes, strip);
      const suffix = chunk.source === "log" ? `\n\n[offset ${chunk.offset} → ${chunk.nextOffset}; endOfLog=${chunk.endOfLog}]` : "";
      return { content: [{ type: "text", text: `${chunk.text}${suffix}` }], details: chunk };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("task logs"))} ${theme.fg("accent", args.taskId)} ${theme.fg("dim", args.source || "log")}`, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as { text?: string; nextOffset?: number; endOfLog?: boolean } | undefined;
      if (!details) return textResult(result, theme);
      const preview = expanded ? details.text ?? "" : (details.text ?? "").split("\n").slice(-4).join("\n");
      return new Text(`${theme.fg("dim", preview || "No output")}\n${theme.fg("muted", `next offset ${details.nextOffset ?? 0}${details.endOfLog ? " · end" : ""}`)}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "task_send",
    label: "Task Input",
    description: "Send literal text, Enter, or a supported control/navigation key to a running background task.",
    promptSnippet: "Send literal text or control keys to a running background terminal",
    parameters: Type.Object({
      taskId: Type.String(),
      text: Type.Optional(Type.String()),
      enter: Type.Optional(Type.Boolean()),
      key: Type.Optional(StringEnum(["Ctrl+C", "Ctrl+D", "Ctrl+Z", "Escape", "Up", "Down", "Left", "Right"] as const)),
    }),
    async execute(_id, params) {
      const task = await registry().send(params.taskId, params);
      return { content: [{ type: "text", text: `Input sent to ${task.taskId}` }], details: task };
    },
    renderCall(args, theme) {
      const action = [args.text !== undefined ? `text ${JSON.stringify(args.text)}` : "", args.key || "", args.enter ? "Enter" : ""].filter(Boolean).join(" + ");
      return new Text(`${theme.fg("toolTitle", theme.bold("task input"))} ${theme.fg("accent", args.taskId)} ${theme.fg("dim", action)}`, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      return renderSummaryOrText(result, theme, expanded);
    },
  });

  pi.registerTool({
    name: "task_wait",
    label: "Wait for Tasks",
    description: "Wait inside one tool call until any or all selected tasks finish, without repeated LLM polling.",
    promptSnippet: "Wait for task completion without repeated LLM polling",
    parameters: Type.Object({
      taskIds: Type.Array(Type.String(), { minItems: 1, maxItems: 50 }),
      mode: Type.Optional(StringEnum(["any", "all"] as const, { default: "all" })),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400 })),
    }),
    async execute(_id, params, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: `Waiting for ${params.taskIds.length} task(s)…` }], details: { waiting: params.taskIds } });
      const result = await registry().wait(params.taskIds, params.mode ?? "all", params.timeoutSeconds, signal);
      return { content: [{ type: "text", text: waitResultText(result) }], details: result };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("task wait"))} ${theme.fg("muted", `${args.mode || "all"} · ${args.taskIds.length} task(s)`)}`, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("accent", "● waiting…"), 0, 0);
      const details = result.details as { completed?: unknown[]; pending?: unknown[]; timedOut?: boolean } | undefined;
      if (!details) return textResult(result, theme);
      const label = details.timedOut ? theme.fg("error", "wait timed out") : theme.fg("success", "wait complete");
      return new Text(`${label} ${theme.fg("dim", `· ${details.completed?.length ?? 0} complete · ${details.pending?.length ?? 0} pending`)}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "task_kill",
    label: "Stop Task",
    description: "Gracefully cancel a running background task, or force-close its tmux session.",
    promptSnippet: "Gracefully stop or force-kill a background task",
    parameters: Type.Object({ taskId: Type.String(), force: Type.Optional(Type.Boolean({ default: false })) }),
    async execute(_id, params) {
      const task = await registry().terminate(params.taskId, "cancelled", params.force ?? false);
      return { content: [{ type: "text", text: `${task.taskId} is ${task.status}.` }], details: task };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold(args.force ? "force stop" : "stop task"))} ${theme.fg("accent", args.taskId)}`, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      return renderSummaryOrText(result, theme, expanded);
    },
  });
}

type ReturnTypeShape = { taskId: string; status: string; name: string; exitCode?: number | null };

export function taskListText(tasks: ReturnTypeShape[]): string {
  if (tasks.length === 0) return "No background tasks on the current session branch.";
  return tasks.map((task) => `${task.taskId}: ${task.status}${task.exitCode === null || task.exitCode === undefined ? "" : `, exit ${task.exitCode}`} (${task.name})`).join("\n");
}

export function waitResultText(result: { completed: ReturnTypeShape[]; pending: string[]; timedOut: boolean }): string {
  const lines = result.completed.map((task) => `${task.taskId}: ${task.status}${task.exitCode === null || task.exitCode === undefined ? "" : `, exit ${task.exitCode}`}`);
  if (result.pending.length > 0) lines.push(`Pending: ${result.pending.join(", ")}`);
  if (result.timedOut) lines.push("Wait timed out; pending tasks are still running.");
  return lines.join("\n") || "No task state changed.";
}

function renderSummaryOrText(result: { content: Array<{ type: string; text?: string }>; details?: unknown }, theme: Parameters<typeof renderToolResult>[1], expanded: boolean): Text {
  const task = result.details as Parameters<typeof renderToolResult>[0] | undefined;
  return task?.taskId ? renderToolResult(task, theme, expanded) : textResult(result, theme);
}

function textResult(result: { content: Array<{ type: string; text?: string }> }, theme: Parameters<typeof renderToolResult>[1]): Text {
  const first = result.content[0];
  return new Text(theme.fg("muted", first?.type === "text" ? first.text ?? "" : ""), 0, 0);
}
