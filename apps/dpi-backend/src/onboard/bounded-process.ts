import { spawn, type SpawnOptions } from "node:child_process";
import { destroyChildStdio, killProcessTree } from "./process-tree.js";

export interface BoundedProcessOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
  spawnProcess?: typeof spawn;
}

export interface BoundedProcessResult {
  stdout: string;
  stderr: string;
}

export class BoundedProcessError extends Error {
  constructor(
    message: string,
    name: string,
    readonly code?: string | number | null,
    readonly killed = false,
  ) {
    super(message);
    this.name = name;
  }
}

function processError(message: string, name: string): BoundedProcessError {
  return new BoundedProcessError(message, name);
}

/** Run argv directly with one deadline, cancellation, and combined bounded stdout/stderr capture. */
export function runBoundedProcess(
  command: string,
  args: readonly string[],
  options: BoundedProcessOptions,
): Promise<BoundedProcessResult> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
    return Promise.reject(new Error("timeoutMs must be a positive safe integer"));
  if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0)
    return Promise.reject(new Error("maxOutputBytes must be a positive safe integer"));
  if (options.signal?.aborted) return Promise.reject(processError("Process cancelled", "AbortError"));

  return new Promise<BoundedProcessResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn> | undefined;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const signal = options.signal;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error, result?: BoundedProcessResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result ?? { stdout: "", stderr: "" });
    };
    const stop = (reason: "timeout" | "cancelled" | "output") => {
      if (settled) return;
      killProcessTree(child);
      destroyChildStdio(child);
      const error = reason === "timeout"
        ? processError(`Process timed out after ${options.timeoutMs}ms: ${command} ${args.join(" ")}`, "TimeoutError")
        : reason === "cancelled"
          ? processError(`Process cancelled: ${command} ${args.join(" ")}`, "AbortError")
          : processError(`Process output exceeded ${options.maxOutputBytes} bytes: ${command} ${args.join(" ")}`, "OutputLimitError");
      finish(error);
    };
    const onAbort = () => stop("cancelled");
    const capture = (target: Buffer[], chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > options.maxOutputBytes) {
        stop("output");
        return;
      }
      target.push(chunk);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(() => stop("timeout"), options.timeoutMs);

    try {
      const spawnOptions: SpawnOptions = {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      };
      child = (options.spawnProcess ?? spawn)(command, [...args], spawnOptions);
      child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk));
      child.once("error", (error) => finish(error));
      child.once("close", (code, childSignal) => {
        if (settled) return;
        const out = Buffer.concat(stdout).toString("utf8");
        const err = Buffer.concat(stderr).toString("utf8");
        if (code === 0 && childSignal === null) {
          finish(undefined, { stdout: out, stderr: err });
          return;
        }
        const status = childSignal ? `signal ${childSignal}` : `exit code ${code}`;
        const detail = err.trim();
        finish(new BoundedProcessError(
          `${command} ${args.join(" ")} failed with ${status}${detail ? `: ${detail}` : ""}`,
          "ProcessExitError",
          childSignal ? String(childSignal) : code,
          childSignal !== null,
        ));
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
