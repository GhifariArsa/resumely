import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { z } from "zod";
import { layout, requireDataRoot } from "./paths";
import { UserError } from "./errors";

const AdapterConfig = z.object({
  command: z.array(z.string()),
  check: z.array(z.string()).optional(),
});

const ConfigSchema = z.object({
  harness: z.string().default("claude"),
  template: z.string().default("classic"),
  pages: z.number().int().positive().default(1),
  timeout_minutes: z.number().positive().default(10),
  filename: z.string().default("{First}_{Last}_{Kind}_{Company}"),
  adapters: z.record(z.string(), AdapterConfig).default({}),
});

export type AdapterConfig = z.infer<typeof AdapterConfig>;
export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(root: string): Config {
  requireDataRoot(root);
  const path = layout(root).config;
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new UserError(`Invalid config at ${path}`, e instanceof Error ? e.message : String(e));
  }
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const hint = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new UserError(`Invalid config at ${path}`, hint);
  }
  return result.data;
}
