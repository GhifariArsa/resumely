export async function openFile(path: string): Promise<void> {
  const bin = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const p = Bun.spawn([bin, path], { stdout: "ignore", stderr: "ignore" });
    await p.exited;
  } catch {
    console.error(`warning: couldn't launch ${bin}; open this file manually: ${path}`);
  }
}
