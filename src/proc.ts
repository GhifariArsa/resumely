import { onInterrupt } from "./signals";

export type SpawnResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
};

const DRAIN_MS = 500;

/**
 * Spawn argv in its own process group with a hard timeout. On timeout the whole group is
 * SIGKILLed (so grandchildren don't hold the pipes open) and partial output is still returned.
 * Spawn errors (e.g. ENOENT) are rethrown with `code` intact.
 */
export async function spawnWithTimeout(
  argv: string[],
  opts: { cwd: string; env?: Record<string, string | undefined>; timeoutMs: number },
): Promise<SpawnResult> {
  const start = Date.now();
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    detached: true,
  });
  const unregister = onInterrupt(() => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  });
  let stdout = "";
  let stderr = "";
  const read = async (s: ReadableStream<Uint8Array>, set: (t: string) => void) => {
    const dec = new TextDecoder();
    let acc = "";
    try {
      const reader = s.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
        set(acc);
      }
      acc += dec.decode();
      set(acc);
    } catch {
      /* stream errored; keep what we have */
    }
  };
  const work = Promise.all([
    read(proc.stdout, (t) => (stdout = t)),
    read(proc.stderr, (t) => (stderr = t)),
    proc.exited,
  ]);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<"timeout">((res) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
      res("timeout");
    }, opts.timeoutMs);
  });
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = await Promise.race([work, timeoutP]);
    if (r === "timeout") {
      // Pipes close once the group is dead; bound the wait so a stuck pipe can't block.
      await Promise.race([work, new Promise((res) => (drainTimer = setTimeout(res, DRAIN_MS)))]);
    }
  } finally {
    unregister();
    clearTimeout(timer);
    clearTimeout(drainTimer);
  }
  return { stdout, stderr, exitCode: timedOut ? null : proc.exitCode, timedOut, durationMs: Date.now() - start };
}
