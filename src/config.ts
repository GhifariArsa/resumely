import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { z } from "zod";
import { layout } from "./paths";

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
  const raw = parse(readFileSync(layout(root).config, "utf8"));
  return ConfigSchema.parse(raw);
}
