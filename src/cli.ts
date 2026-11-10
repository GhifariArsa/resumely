#!/usr/bin/env bun
import { Command } from "commander";
import { UserError } from "./errors";
import { resolveDataRoot } from "./paths";
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
