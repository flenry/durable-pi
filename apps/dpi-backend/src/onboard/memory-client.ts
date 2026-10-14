// The one seam to personal memory: pi-setup's JSON CLI, on its host or over SSH. Only project keys
// cross this seam; a local checkout path is used for identity on this device and never sent remotely.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { OnboardOptions } from "./config.js";

export interface MemoryClient {
  call<T>(command: string, input: object, context?: Context): Promise<T>;
}

export class MemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryError";
  }
}

export const MEMORY_COMMANDS = ["index", "read", "note", "rewrite", "expert", "roster"] as const;
type MemoryCommand = (typeof MEMORY_COMMANDS)[number];
const MAX_HOST_LENGTH = 253;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_MAX_INPUT_BYTES = 1_000_000;
const MAX_STDERR_BYTES = 32_000;

export interface MemoryClientSettings {
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxInputBytes?: number;
  /** Spawn seam for deterministic process tests; production uses node:child_process.spawn. */
  spawn?: typeof spawn;
}

function checkedCommand(command: string): MemoryCommand {
  if (!(MEMORY_COMMANDS as readonly string[]).includes(command))
    throw new MemoryError("Unsupported memory command");
  return command as MemoryCommand;
}

function checkedHost(host: string): string {
  if (
    host.length > MAX_HOST_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host) ||
    host === "." ||
    host === ".."
  ) {
    throw new MemoryError("DPI_MEMORY_HOST must be a safe SSH alias (letters, numbers, dots, underscores, or hyphens)");
  }
  return host;
}

/** Build an argv-only invocation. The remote command is an allowlisted token, never caller text. */
export function memoryCommand(opts: OnboardOptions, command: string): { cmd: string; args: string[] } {
  const safeCommand = checkedCommand(command);
  if (opts.memory === "off") throw new MemoryError("memory is off on this device (DPI_MEMORY=off)");
  if (opts.memory === "ssh") {
    return {
      cmd: "ssh",
      args: [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "--",
        checkedHost(opts.memoryHost),
        "pi-memory",
        safeCommand,
      ],
    };
  }
  if (opts.memory !== "local") throw new MemoryError("DPI_MEMORY must be local, ssh, or off");
  return { cmd: process.execPath, args: [resolve(opts.setupDir, "bin", "pi-memory.ts"), safeCommand] };
}

function asBuffer(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createMemoryClient(opts: OnboardOptions, settings: MemoryClientSettings = {}): MemoryClient {
  const timeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = settings.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxInputBytes = settings.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  const spawnProcess = settings.spawn ?? spawn;
  for (const [name, value] of Object.entries({ timeoutMs, maxOutputBytes, maxInputBytes })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  }

  return {
    call<T>(command: string, input: object, context?: Context): Promise<T> {
      if (opts.memory === "off") return Promise.reject(new MemoryError("memory is off on this device (DPI_MEMORY=off)"));
      if (context?.abortSignal?.aborted)
        return Promise.reject(new MemoryError(`memory unavailable: ${command} request was cancelled`));
      let invocation: { cmd: string; args: string[] };
      let payload: string;
      try {
        invocation = memoryCommand(opts, command);
        payload = JSON.stringify(input);
        if (typeof payload !== "string") throw new Error("input is not JSON serializable");
      } catch (error) {
        return Promise.reject(error instanceof MemoryError ? error : new MemoryError(`invalid memory request: ${errorText(error)}`));
      }
      const inputBytes = Buffer.byteLength(payload);
      if (inputBytes > maxInputBytes)
        return Promise.reject(new MemoryError(`memory request exceeded ${maxInputBytes} bytes`));

      return new Promise<T>((resolve, reject) => {
        let child: ReturnType<typeof spawn>;
        try {
          child = spawnProcess(invocation.cmd, invocation.args, {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          });
        } catch (error) {
          reject(new MemoryError(`memory unavailable: could not start process (${errorText(error)})`));
          return;
        }

        const stdin = child.stdin;
        const stdoutStream = child.stdout;
        const stderrStream = child.stderr;
        if (!stdin || !stdoutStream || !stderrStream) {
          child.kill("SIGKILL");
          reject(new MemoryError("memory unavailable: process pipes could not be created"));
          return;
        }

        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let settled = false;
        let timer: NodeJS.Timeout | undefined;

        const abortSignal = context?.abortSignal;
        const onAbort = () => finishError(`memory unavailable: ${command} request was cancelled`);
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          abortSignal?.removeEventListener("abort", onAbort);
        };
        const finishError = (message: string, kill = true) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (kill) child.kill("SIGKILL");
          reject(new MemoryError(message));
        };

        timer = setTimeout(() => {
          finishError(`memory unavailable: ${command} timed out after ${timeoutMs}ms`);
        }, timeoutMs);
        abortSignal?.addEventListener("abort", onAbort, { once: true });
        if (abortSignal?.aborted) onAbort();

        stdoutStream.on("data", (chunk: Buffer | string) => {
          if (settled) return;
          const data = asBuffer(chunk);
          if (stdoutBytes + data.byteLength > maxOutputBytes) {
            finishError(`memory unavailable: ${command} output exceeded ${maxOutputBytes} bytes`);
            return;
          }
          stdoutBytes += data.byteLength;
          stdout.push(data);
        });
        stderrStream.on("data", (chunk: Buffer | string) => {
          if (settled || stderrBytes >= MAX_STDERR_BYTES) return;
          const data = asBuffer(chunk).subarray(0, MAX_STDERR_BYTES - stderrBytes);
          stderrBytes += data.byteLength;
          stderr.push(data);
        });
        stdin.on("error", (error: NodeJS.ErrnoException) => {
          const detail = error.code === "EPIPE" ? "closed its input before the request was sent (EPIPE)" : errorText(error);
          finishError(`memory unavailable: ${command} process ${detail}`);
        });
        child.on("error", (error) => {
          finishError(`memory unavailable: could not start process (${errorText(error)})`, false);
        });
        child.on("close", (code, signal) => {
          if (settled) return;
          settled = true;
          cleanup();
          const output = Buffer.concat(stdout).toString("utf8").trim();
          const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
          let parsed: unknown;
          try {
            parsed = JSON.parse(output);
          } catch {
            parsed = undefined;
          }
          const cliError = isObject(parsed) && typeof parsed.error === "string" ? parsed.error : undefined;
          if (opts.memory === "ssh" && code === 255) {
            reject(new MemoryError("memory unavailable: VM unreachable"));
          } else if (code === 0 && parsed !== undefined && !cliError) {
            resolve(parsed as T);
          } else {
            const why = cliError ?? (diagnostic || `process exited ${code ?? signal ?? "without a status"}`);
            reject(new MemoryError(`memory unavailable: ${why}`));
          }
        });

        try {
          if (!settled) stdin.end(payload);
        } catch (error) {
          finishError(`memory unavailable: could not send request to ${command} (${errorText(error)})`);
        }
      });
    },
  };
}
