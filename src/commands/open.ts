import { dirname } from "node:path";

export async function openFile(path: string): Promise<void> {
  const bin = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const p = Bun.spawn([bin, path], { stdout: "ignore", stderr: "ignore" });
    await p.exited;
  } catch {
    console.error(`warning: couldn't launch ${bin}; open this file manually: ${path}`);
  }
}

/** The file-manager command for `path`: macOS selects the file in Finder; elsewhere its folder is opened. */
export function revealArgv(path: string, platform: NodeJS.Platform): string[] {
  return platform === "darwin" ? ["open", "-R", path] : ["xdg-open", dirname(path)];
}

/**
 * Start `argv` without waiting for it to exit: some Linux `xdg-open` setups block until the file manager closes,
 * which would hang the UI request. Prints `warning` when it can't start.
 */
export function launchDetached(argv: string[], warning: string): void {
  try {
    Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  } catch {
    console.error(warning);
  }
}

/** Show `path` in the OS file manager. */
export async function revealFile(path: string): Promise<void> {
  launchDetached(revealArgv(path, process.platform), `warning: couldn't open the file manager; the file is at ${path}`);
}
