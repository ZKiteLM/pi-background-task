import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskMeta, TaskPaths } from "./types.js";
import { shellQuote } from "./utils.js";

const execFileAsync = promisify(execFile);

export class TmuxBackend {
  constructor(readonly socketName: string, private readonly runnerPath: string) {}

  async assertAvailable(): Promise<void> {
    if (process.platform === "win32") {
      throw new Error("pi-background-task requires tmux on macOS/Linux (or inside WSL)");
    }
    try {
      await execFileAsync("tmux", ["-V"], { timeout: 3_000 });
    } catch {
      throw new Error("tmux is required but was not found in PATH");
    }
  }

  async start(meta: TaskMeta, paths: TaskPaths): Promise<void> {
    const runnerCommand = `${shellQuote(process.execPath)} ${shellQuote(this.runnerPath)} ${shellQuote(paths.dir)}`;
    await this.run([
      "new-session",
      "-d",
      "-s",
      meta.sessionName,
      "-c",
      meta.cwd,
      runnerCommand,
    ]);
    const pipeCommand = `cat >> ${shellQuote(paths.log)}`;
    try {
      await this.run(["pipe-pane", "-t", meta.sessionName, "-o", pipeCommand]);
    } catch (error) {
      await this.kill(meta.sessionName).catch(() => undefined);
      throw error;
    }
  }

  async hasSession(session: string): Promise<boolean> {
    try {
      await this.run(["has-session", "-t", session]);
      return true;
    } catch {
      return false;
    }
  }

  async sendLiteral(session: string, text: string): Promise<void> {
    await this.run(["send-keys", "-t", session, "-l", "--", text]);
  }

  async sendKey(session: string, key: string): Promise<void> {
    await this.run(["send-keys", "-t", session, key]);
  }

  async capturePane(session: string, lines = 200): Promise<string> {
    const safeLines = Math.max(1, Math.min(500, Math.floor(lines)));
    const { stdout } = await this.run(["capture-pane", "-p", "-t", session, "-S", `-${safeLines}`]);
    return stdout;
  }

  async kill(session: string): Promise<void> {
    if (await this.hasSession(session)) await this.run(["kill-session", "-t", session]);
  }

  attachCommand(session: string): string {
    return `tmux -L ${shellQuote(this.socketName)} attach-session -t ${shellQuote(session)}`;
  }

  private async run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileAsync("tmux", ["-L", this.socketName, ...args], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 2 * 1024 * 1024,
      });
    } catch (error) {
      const execError = error as Error & { stderr?: string };
      throw new Error(`tmux ${args[0] ?? "command"} failed: ${execError.stderr?.trim() || execError.message}`);
    }
  }
}
