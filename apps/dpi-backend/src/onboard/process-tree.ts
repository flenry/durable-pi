import { spawn, type ChildProcess } from "node:child_process";

/** Force-stop a detached command and descendants; on Unix the child PID is its process-group ID. */
export function killProcessTree(child: ChildProcess | undefined): void {
  if (!child) return;
  if (child.pid === undefined) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* forced settlement still proceeds */ }
    }
    return;
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try { child.kill("SIGKILL"); } catch { /* forced settlement still proceeds */ }
    }
    return;
  }

  let killer: ChildProcess;
  try {
    killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    try { child.kill("SIGKILL"); } catch { /* forced settlement still proceeds */ }
    return;
  }
  const killDirectChild = () => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* forced settlement still proceeds */ }
    }
  };
  killer.once("error", killDirectChild);
  killer.once("exit", (code) => { if (code !== 0) killDirectChild(); });
}

export function destroyChildStdio(child: ChildProcess | undefined): void {
  child?.stdin?.destroy();
  child?.stdout?.destroy();
  child?.stderr?.destroy();
}
