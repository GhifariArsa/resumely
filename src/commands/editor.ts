import { UserError } from "../errors";

type Env = Record<string, string | undefined>;

/** `$VISUAL`, else `$EDITOR`, else `vi`, split on whitespace (never passed to a shell). */
export function editorArgv(env: Env = process.env): string[] {
  return (env.VISUAL || env.EDITOR || "vi").trim().split(/\s+/);
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
