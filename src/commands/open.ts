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

/** Show `path` in the OS file manager. */
export async function revealFile(path: string): Promise<void> {
  try {
    const p = Bun.spawn(revealArgv(path, process.platform), { stdout: "ignore", stderr: "ignore" });
    await p.exited;
  } catch {
    console.error(`warning: couldn't open the file manager; the file is at ${path}`);
  }
}
