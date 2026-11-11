import { existsSync } from "node:fs";
import { UserError } from "../errors";

type Env = Record<string, string | undefined>;

/**
 * The editor command as argv (never passed to a shell): the first non-blank of `$VISUAL`, `$EDITOR`, else `vi`.
 * A value naming an existing file is one argument (a path may contain spaces); otherwise it is split on whitespace.
 */
export function editorArgv(env: Env = process.env): string[] {
  const editor = [env.VISUAL, env.EDITOR].find((v) => v?.trim()) ?? "vi";
  return existsSync(editor) ? [editor] : editor.trim().split(/\s+/);
}

export async function openInEditor(file: string, env: Env = process.env): Promise<void> {
  const argv = editorArgv(env);
  let code: number;
  try {
    const p = Bun.spawn([...argv, file], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    code = await p.exited;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new UserError(`Editor "${argv[0]}" not found`, "Set $EDITOR, e.g. export EDITOR=nano");
    throw e;
  }
  if (code !== 0) throw new UserError(`Editor exited with ${code}; proposal unchanged`);
}
