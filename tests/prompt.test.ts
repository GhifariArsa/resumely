import { test, expect } from "bun:test";
import { confirmParsed, promptDuplicate } from "../src/commands/prompt";
import type { Application } from "../src/application/store";

const app = { slug: "2026-01-01-acme-dev" } as Application;
const job = { company: "Acme", role: "Dev", location: "Remote", requirements: ["Rust"], nice_to_haves: [], keywords: [], language: "en" };
async function* feed(...chunks: string[]) {
  for (const c of chunks) yield c;
}
const sink = () => {
  const out: string[] = [];
  return { out, output: { write: (s: string) => out.push(s) } };
};

test("duplicate prompt: v/n/a are case-insensitive and anything else re-asks", async () => {
  const s = sink();
  expect(await promptDuplicate(app, { input: feed("x\n", "V\n"), output: s.output })).toBe("existing");
  expect(s.out.filter((o) => o.startsWith("Already applied (2026-01-01-acme-dev).")).length).toBe(2);
  expect(await promptDuplicate(app, { input: feed("N\n"), output: sink().output })).toBe("new");
  expect(await promptDuplicate(app, { input: feed("a", "\n"), output: sink().output })).toBe("abort");
});

test("duplicate prompt: EOF aborts", async () => {
  expect(await promptDuplicate(app, { input: feed(), output: sink().output })).toBe("abort");
  expect(await promptDuplicate(app, { input: feed("zzz\n"), output: sink().output })).toBe("abort");
});

test("confirmParsed shows the job and defaults to yes", async () => {
  const s = sink();
  expect(await confirmParsed(job, ["Kafka"], { input: feed("\n"), output: s.output })).toBe(true);
  const text = s.out.join("");
  expect(text).toContain("Acme");
  expect(text).toContain("  - Rust");
  expect(text).toContain("likely gaps:\n  - Kafka");
  expect(text).toContain("Continue? [Y/n] ");
  expect(await confirmParsed(job, [], { input: feed("n\n"), output: sink().output })).toBe(false);
  expect(await confirmParsed(job, [], { input: feed(), output: sink().output })).toBe(false);
});
