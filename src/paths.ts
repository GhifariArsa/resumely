import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UserError } from "./errors";

export function resolveDataRoot(env: Record<string, string | undefined> = process.env): string {
  if (env.RESUMELY_HOME) return env.RESUMELY_HOME;
  return join(env.HOME ?? homedir(), "resumely");
}

export function layout(root: string) {
  return {
    config: join(root, "config.toml"),
    profile: join(root, "profile"),
    applications: join(root, "applications"),
    templates: join(root, "templates"),
    runs: join(root, ".runs"),
  };
}

export function requireDataRoot(root: string): void {
  if (!existsSync(layout(root).config)) {
    throw new UserError(`No resumely data root at ${root}`, "Run: resumely init");
  }
}
