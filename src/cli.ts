#!/usr/bin/env bun
import { Command } from "commander";
import { UserError } from "./errors";
import { resolveDataRoot, requireDataRoot, layout } from "./paths";
import { loadProfile } from "./profile/load";
import { formatEntry, formatProfileContext, formatProfileTree } from "./profile/context";
import { initDataRoot } from "./commands/init";

const program = new Command();
program.name("resumely").description("Agent-driven resume tailoring");

program
  .command("init")
  .description("Create the resumely data root")
  .action(() => {
    const root = resolveDataRoot();
    initDataRoot(root);
    console.log(`Initialized resumely data root at ${root}`);
  });

const profile = program.command("profile").description("Inspect your profile");

function load() {
  const root = resolveDataRoot();
  requireDataRoot(root);
  return loadProfile(layout(root).profile);
}

profile
  .command("show [id]")
  .description("Show the profile tree, or a single entry")
  .action((id?: string) => {
    const p = load();
    if (!id) return console.log(formatProfileTree(p));
    const e = p.entries.find((x) => x.id === id);
    if (!e) throw new UserError(`No entry with id "${id}"`, `Known ids: ${p.entries.map((x) => x.id).join(", ") || "(none)"}`);
    console.log(formatEntry(e));
  });

profile
  .command("context")
  .description("Print exactly what the agent will see (private content withheld)")
  .action(() => console.log(formatProfileContext(load())));

try {
  await program.parseAsync(process.argv);
} catch (e) {
  if (e instanceof UserError) {
    console.error(`error: ${e.message}`);
    if (e.hint) console.error(`hint: ${e.hint}`);
    process.exit(1);
  }
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  console.error("This is unexpected, please report it.");
  process.exit(2);
}
