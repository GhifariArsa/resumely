import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HardFacts } from "../src/checks/facts";
import { UserError } from "../src/errors";
import { loadProfile } from "../src/profile/load";
import { refine, revisionInstructions, writeRevisionFiles, type Produced } from "../src/pipeline/refine";
import { reviewSchemaFor, type Review, type ResumeContent } from "../src/pipeline/schemas";
import { validateResume, validateReview } from "../src/pipeline/validate";
import { runAgentStep } from "../src/pipeline/workspace";

const fx = join(import.meta.dir, "fixtures");
const adapter = { command: ["bun", join(fx, "fake-harness.ts"), "{workspace}"] };
const profile = loadProfile(join(fx, "profile-jordan"));
const resume: ResumeContent = JSON.parse(readFileSync(join(fx, "resume-content.json"), "utf8"));
const pass: Review = JSON.parse(readFileSync(join(fx, "review-pass.json"), "utf8"));
const revise: Review = JSON.parse(readFileSync(join(fx, "review-revise.json"), "utf8"));
const revised: ResumeContent = structuredClone(resume);
revised.sections[0]!.items[0]!.bullets.reverse();
const revised2: ResumeContent = structuredClone(revised);
revised2.skills[0]!.items.reverse();

const facts = (over: Partial<HardFacts> = {}): HardFacts => ({
  pages: 1,
  target_pages: 1,
  fill: 0.92,
  overflow: false,
  underflow: false,
  word_count: 400,
  keywords: { present: ["Go"], missed_in_profile: ["PostgreSQL"], absent: ["Rust"] },
  ats: { status: "ok", problems: [] },
  fabrication_warnings: [],
  ...over,
});

let dir: string;
const saved = { s: process.env.FAKE_HARNESS_SCRIPT, f: process.env.FAKE_HARNESS_FAIL_STEP };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "resumely-refine-"));
  delete process.env.FAKE_HARNESS_FAIL_STEP;
});
afterEach(() => {
  for (const [k, v] of [["FAKE_HARNESS_SCRIPT", saved.s], ["FAKE_HARNESS_FAIL_STEP", saved.f]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

function script(s: Record<string, Record<string, unknown>[]>) {
  const p = join(dir, "script.json");
  writeFileSync(p, JSON.stringify(s));
  process.env.FAKE_HARNESS_SCRIPT = p;
}
const calls = () => {
  const p = join(dir, "script.json.calls");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n") : [];
};
const runDir = () => join(dir, "runs", "r1");
const out = (r: unknown) => ({ "out/resume.json": r });
const rev = (r: unknown) => ({ "out/review.json": r });

/** Writer callback as Task 7 will build it: real validator, revision files and instructions on revisions. */
async function write(ws: string, revision?: { previous: ResumeContent; review: Review; facts: HardFacts }) {
  let instructions = "Write the resume.";
  if (revision) {
    writeRevisionFiles(ws, revision);
    instructions += "\n\n" + (await revisionInstructions());
  }
  return runAgentStep({
    adapter,
    name: "fake",
    workspace: ws,
    instructions,
    files: { "profile.json": JSON.stringify({ entries: profile.entries }) },
    outFile: "resume.json",
    validate: (raw) => validateResume(raw, profile, "truthful"),
    timeoutMs: 20000,
  });
}

function producer(factsFor: (n: number) => HardFacts = () => facts()) {
  const seen: ResumeContent[] = [];
  const produce = async (value: ResumeContent): Promise<Produced> => {
    seen.push(value);
    return { tex: "\\tex", pdf: new Uint8Array([37, 80, 68, 70]), pages: 1, fill: 0.92, facts: factsFor(seen.length - 1), text: `TEXT ${seen.length}` };
  };
  return { produce, seen };
}

const go = (over: Partial<Parameters<typeof refine<ResumeContent>>[0]> = {}) =>
  refine<ResumeContent>({
    kind: "resume",
    runsDir: join(dir, "runs"),
    runId: "r1",
    adapter,
    name: "fake",
    timeoutMs: 20000,
    maxRounds: 2,
    write,
    produce: producer().produce,
    reviewFiles: { "job.md": "# Senior Backend Engineer\nGo, PostgreSQL, Rust, Kafka" },
    ...over,
  });

const reviewWorkspaces = () => readdirSync(runDir()).filter((n) => /-review-\d+$/.test(n)).map((n) => join(runDir(), n));

describe("refine", () => {
  test("pass on the first review: [write, review-1]", async () => {
    script({ "resume-write": [out(resume)], "resume-review-1": [rev(pass)] });
    const p = producer();
    const r = await go({ produce: p.produce });
    expect(calls()).toEqual(["resume-write", "resume-review-1"]);
    expect(r.rounds).toBe(1);
    expect(r.reviewedFinal).toBe(true);
    expect(r.review).toEqual(pass);
    expect(r.value).toEqual(resume);
    expect(r.produced.text).toBe("TEXT 1");
    expect(p.seen.length).toBe(1);
    const ws = join(runDir(), "resume-review-1");
    for (const f of ["document.pdf", "document.txt", "job.md", "hard-facts.json", "review.schema.json", "instructions.md"]) expect(existsSync(join(ws, f))).toBe(true);
    expect(existsSync(join(ws, "profile.json"))).toBe(false);
    expect(readFileSync(join(ws, "document.txt"), "utf8")).toBe("TEXT 1");
    expect([...readFileSync(join(ws, "document.pdf"))]).toEqual([37, 80, 68, 70]);
    expect(JSON.parse(readFileSync(join(ws, "hard-facts.json"), "utf8"))).toEqual(facts());
    expect(readFileSync(join(ws, "job.md"), "utf8")).toContain("Senior Backend Engineer");
    expect(JSON.parse(readFileSync(join(ws, "review.schema.json"), "utf8")).properties.verdict).toBeDefined();
    const instr = readFileSync(join(ws, "instructions.md"), "utf8");
    expect(instr).toContain("6-second skim");
    expect(instr).toContain("no access to the candidate's profile");
    // the writer workspace did get the profile; the reviewer never does
    expect(existsSync(join(runDir(), "resume-write", "profile.json"))).toBe(true);
  });

  test("revise then pass: [write, review-1, revise-1, review-2]", async () => {
    script({ "resume-write": [out(resume)], "resume-review-1": [rev(revise)], "resume-revise-1": [out(revised)], "resume-review-2": [rev(pass)] });
    const p = producer();
    const r = await go({ produce: p.produce });
    expect(calls()).toEqual(["resume-write", "resume-review-1", "resume-revise-1", "resume-review-2"]);
    expect(r.rounds).toBe(2);
    expect(r.reviewedFinal).toBe(true);
    expect(r.review).toEqual(pass);
    expect(r.value).toEqual(revised);
    expect(r.produced.text).toBe("TEXT 2");
    expect(p.seen).toEqual([resume, revised]);
    const vws = join(runDir(), "resume-revise-1");
    expect(JSON.parse(readFileSync(join(vws, "previous.json"), "utf8"))).toEqual(resume);
    expect(JSON.parse(readFileSync(join(vws, "review.json"), "utf8"))).toEqual(revise);
    expect(JSON.parse(readFileSync(join(vws, "hard-facts.json"), "utf8"))).toEqual(facts());
    expect(readFileSync(join(vws, "instructions.md"), "utf8")).toContain("Address every request that can be met truthfully.");
    expect(readFileSync(join(runDir(), "resume-review-2", "document.txt"), "utf8")).toBe("TEXT 2");
  });

  test("revise, revise with maxRounds 2 ends on a revision; no review workspace has profile.json", async () => {
    script({
      "resume-write": [out(resume)],
      "resume-review-1": [rev(revise)],
      "resume-revise-1": [out(revised)],
      "resume-review-2": [rev(revise)],
      "resume-revise-2": [out(revised2)],
    });
    const r = await go();
    expect(calls()).toEqual(["resume-write", "resume-review-1", "resume-revise-1", "resume-review-2", "resume-revise-2"]);
    expect(r.rounds).toBe(2);
    expect(r.reviewedFinal).toBe(false);
    expect(r.review).toEqual(revise);
    expect(r.value).toEqual(revised2);
    expect(r.warnings).toEqual([]);
    const reviews = reviewWorkspaces();
    expect(reviews.length).toBe(2);
    for (const ws of reviews) expect(existsSync(join(ws, "profile.json"))).toBe(false);
  });

  test("R16: a revision identical to the previous value ends the loop with a warning", async () => {
    script({ "resume-write": [out(resume)], "resume-review-1": [rev(revise)], "resume-revise-1": [out(structuredClone(resume))], "resume-review-2": [rev(pass)] });
    const p = producer();
    const r = await go({ produce: p.produce });
    expect(calls()).toEqual(["resume-write", "resume-review-1", "resume-revise-1"]);
    expect(r.value).toEqual(resume);
    expect(p.seen).toEqual([resume]);
    expect(r.review).toEqual(revise);
    // the kept value is the one review-1 judged
    expect(r.reviewedFinal).toBe(true);
    expect(r.rounds).toBe(1);
    expect(r.warnings).toEqual(["revision made no changes"]);
  });

  test("maxRounds 0: only [write], review null", async () => {
    script({ "resume-write": [out(resume)] });
    const r = await go({ maxRounds: 0 });
    expect(calls()).toEqual(["resume-write"]);
    expect(r.review).toBeNull();
    expect(r.rounds).toBe(0);
    expect(r.reviewedFinal).toBe(false);
    expect(r.value).toEqual(resume);
  });

  test("pass with overflow still revises", async () => {
    script({ "resume-write": [out(resume)], "resume-review-1": [rev(pass)], "resume-revise-1": [out(revised)], "resume-review-2": [rev(pass)] });
    const p = producer((n) => facts(n === 0 ? { pages: 2, overflow: true } : {}));
    const r = await go({ produce: p.produce });
    expect(calls()).toEqual(["resume-write", "resume-review-1", "resume-revise-1", "resume-review-2"]);
    expect(r.value).toEqual(revised);
    expect(r.reviewedFinal).toBe(true);
    expect(JSON.parse(readFileSync(join(runDir(), "resume-revise-1", "hard-facts.json"), "utf8")).overflow).toBe(true);
  });

  test("overflow never causes more than maxRounds revisions", async () => {
    script({ "resume-write": [out(resume)], "resume-review-1": [rev(pass)], "resume-revise-1": [out(revised)] });
    const r = await go({ maxRounds: 1, produce: producer(() => facts({ pages: 2, overflow: true })).produce });
    expect(calls()).toEqual(["resume-write", "resume-review-1", "resume-revise-1"]);
    expect(r.rounds).toBe(1);
    expect(r.reviewedFinal).toBe(false);
    expect(r.value).toEqual(revised);
  });

  test("Review Focus 2: an unsupported skill requested by the reviewer is rejected; previous kept", async () => {
    expect(JSON.stringify(profile).toLowerCase()).not.toContain("kafka");
    const askKafka: Review = { ...revise, requests: ["Skills: add Kafka to the Tools group; the posting requires it."] };
    const withKafka = structuredClone(resume);
    withKafka.skills[2]!.items.unshift("Kafka");
    script({ "resume-write": [out(resume)], "resume-review-1": [rev(askKafka)], "resume-revise-1": [out(withKafka)] });
    const p = producer();
    const r = await go({ produce: p.produce });
    expect(calls()).toEqual(["resume-write", "resume-review-1", "resume-revise-1", "resume-revise-1", "resume-revise-1"]);
    expect(r.value).toEqual(resume);
    expect(JSON.stringify(r.value)).not.toContain("Kafka");
    expect(p.seen).toEqual([resume]);
    expect(r.produced.text).toBe("TEXT 1");
    expect(r.review).toEqual(askKafka);
    // the kept value is the one the review judged
    expect(r.reviewedFinal).toBe(true);
    expect(r.warnings).toEqual([`revision rejected: Agent output invalid after 3 attempts (logs: ${join(runDir(), "resume-revise-1")})`]);
    expect(readFileSync(join(runDir(), "resume-revise-1", "errors.md"), "utf8")).toContain('"Kafka" is not in your profile');
  });

  test("invalid review after retries ends the loop with a warning, keeps the current version", async () => {
    script({ "resume-write": [out(resume)], "resume-review-1": [rev({ verdict: "maybe" })] });
    const r = await go();
    expect(calls()).toEqual(["resume-write", "resume-review-1", "resume-review-1", "resume-review-1"]);
    expect(r.value).toEqual(resume);
    expect(r.review).toBeNull();
    expect(r.reviewedFinal).toBe(false);
    expect(r.rounds).toBe(1);
    const ws = join(runDir(), "resume-review-1");
    expect(r.warnings).toEqual([`review failed: Agent output invalid after 3 attempts (logs: ${ws})`]);
  });

  test("a failing second review keeps the revised version and the last review", async () => {
    script({ "resume-write": [out(resume)], "resume-review-1": [rev(revise)], "resume-revise-1": [out(revised)] });
    process.env.FAKE_HARNESS_FAIL_STEP = "resume-review-2";
    const r = await go();
    expect(calls()).toEqual(["resume-write", "resume-review-1", "resume-revise-1", "resume-review-2"]);
    expect(r.value).toEqual(revised);
    expect(r.review).toEqual(revise);
    expect(r.reviewedFinal).toBe(false);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toStartWith("review failed: ");
    expect(r.warnings[0]).toEndWith(`(logs: ${join(runDir(), "resume-review-2")})`);
    // the harness hint is kept, the workspace is named once
    expect(r.warnings[0]!.match(/\(logs: /g)!.length).toBe(1);
    expect(r.warnings[0]).toMatch(/^review failed: .+ \(.+\) \(logs: /);
  });

  test("a failure of the initial write propagates", async () => {
    script({ "resume-write": [out({ sections: [] })] });
    const e = await go().catch((x) => x);
    expect(e).toBeInstanceOf(UserError);
    expect((e as UserError).message).toBe("Agent output invalid after 3 attempts");
    expect(calls()).toEqual(["resume-write", "resume-write", "resume-write"]);
  });

  test("produce failure on the initial write propagates", async () => {
    script({ "resume-write": [out(resume)] });
    const e = await go({ produce: async () => { throw new UserError("LaTeX compile failed"); } }).catch((x) => x);
    expect(e).toBeInstanceOf(UserError);
    expect(calls()).toEqual(["resume-write"]);
  });

  test("produce failure on a revision keeps the previous version", async () => {
    script({ "resume-write": [out(resume)], "resume-review-1": [rev(revise)], "resume-revise-1": [out(revised)] });
    const p = producer();
    const produce = async (v: ResumeContent) => {
      if (v === p.seen[0] || p.seen.length === 0) return p.produce(v);
      throw new UserError("LaTeX compile failed", "see log");
    };
    const r = await go({ produce });
    expect(calls()).toEqual(["resume-write", "resume-review-1", "resume-revise-1"]);
    expect(r.value).toEqual(resume);
    expect(r.produced.text).toBe("TEXT 1");
    expect(r.reviewedFinal).toBe(true);
    expect(r.warnings).toEqual(["revision failed to compile: LaTeX compile failed (see log)"]);
  });

  test("non-UserError from produce propagates", async () => {
    script({ "resume-write": [out(resume)], "resume-review-1": [rev(revise)], "resume-revise-1": [out(revised)] });
    let n = 0;
    const produce = async (v: ResumeContent) => {
      if (n++ === 0) return producer().produce(v);
      throw new TypeError("boom");
    };
    await expect(go({ produce })).rejects.toThrow("boom");
  });

  test("absent must-haves are red flags, not low scores: a high-scoring pass stops after review-1", async () => {
    const absent = facts({ keywords: { present: ["Go", "PostgreSQL"], missed_in_profile: [], absent: ["Rust", "Kafka"] } });
    const highPass: Review = { ...pass, scores: { relevance: 4, keywords: 4, impact: 4, formatting: 5 }, red_flags: ["No Rust or Kafka, both required."] };
    expect(validateReview(highPass, "resume").ok).toBe(true);
    script({ "resume-write": [out(resume)], "resume-review-1": [rev(highPass)] });
    const r = await go({ produce: producer(() => absent).produce });
    expect(calls()).toEqual(["resume-write", "resume-review-1"]);
    expect(r.reviewedFinal).toBe(true);
    expect(r.warnings).toEqual([]);
    const ws = join(runDir(), "resume-review-1");
    expect(JSON.parse(readFileSync(join(ws, "hard-facts.json"), "utf8")).keywords.absent).toEqual(["Rust", "Kafka"]);
    const instr = readFileSync(join(ws, "instructions.md"), "utf8");
    expect(instr).toContain("`absent` keywords and must-haves the candidate lacks go in `red_flags` and never lower any score");
    expect(instr).toContain("missed_in_profile");
  });

  test("cover-letter revise path: [cover-write, cover-review-1, cover-revise-1, cover-review-2]; cover schema requires voice/templated", async () => {
    const coverRevise: Review = { ...revise, scores: { ...revise.scores, voice: 2 }, templated: true };
    const coverPass: Review = { ...pass, scores: { ...pass.scores, voice: 4 }, templated: false };
    script({
      "cover-write": [{ "out/letter.json": { text: "v1" } }],
      "cover-review-1": [rev(coverRevise)],
      "cover-revise-1": [{ "out/letter.json": { text: "v2" } }],
      "cover-review-2": [rev(coverPass)],
    });
    const seen: string[] = [];
    const r = await refine<{ text: string }>({
      kind: "cover-letter",
      runsDir: join(dir, "runs"),
      runId: "r1",
      adapter,
      name: "fake",
      timeoutMs: 20000,
      maxRounds: 2,
      write: async (ws, revision) => {
        let instructions = "w";
        if (revision) {
          writeRevisionFiles(ws, revision);
          instructions += "\n\n" + (await revisionInstructions());
        }
        return runAgentStep({ adapter, name: "fake", workspace: ws, instructions, files: {}, outFile: "letter.json", validate: (raw) => ({ ok: true, value: raw as { text: string }, warnings: [] }), timeoutMs: 20000 });
      },
      produce: async (v) => {
        seen.push(v.text);
        return { tex: "", pdf: new Uint8Array([1]), pages: 1, fill: null, facts: facts(), text: v.text };
      },
      reviewFiles: { "job.md": "JD" },
    });
    expect(calls()).toEqual(["cover-write", "cover-review-1", "cover-revise-1", "cover-review-2"]);
    expect(r.value).toEqual({ text: "v2" });
    expect(r.review).toEqual(coverPass);
    expect(r.reviewedFinal).toBe(true);
    expect(seen).toEqual(["v1", "v2"]);
    const vws = join(runDir(), "cover-revise-1");
    expect(JSON.parse(readFileSync(join(vws, "previous.json"), "utf8"))).toEqual({ text: "v1" });
    expect(JSON.parse(readFileSync(join(vws, "review.json"), "utf8"))).toEqual(coverRevise);
    expect(readFileSync(join(runDir(), "cover-review-2", "document.txt"), "utf8")).toBe("v2");
    const schema = JSON.parse(readFileSync(join(runDir(), "cover-review-1", "review.schema.json"), "utf8"));
    expect(schema.required).toContain("templated");
    expect(schema.properties.scores.required).toContain("voice");
    const resumeSchema = reviewSchemaFor("resume") as { required: string[]; properties: { scores: { required: string[] } } };
    expect(resumeSchema.required).not.toContain("templated");
    expect(resumeSchema.properties.scores.required).not.toContain("voice");
  });

  test("cover-letter kind uses cover-* workspaces and the cover reviewer prompt", async () => {
    const coverPass: Review = { ...pass, scores: { ...pass.scores, voice: 4 }, templated: false };
    const letter = { text: "v1" };
    script({ "cover-write": [{ "out/letter.json": letter }], "cover-review-1": [rev(coverPass)] });
    const r = await refine<{ text: string }>({
      kind: "cover-letter",
      runsDir: join(dir, "runs"),
      runId: "r1",
      adapter,
      name: "fake",
      timeoutMs: 20000,
      maxRounds: 2,
      write: (ws) =>
        runAgentStep({ adapter, name: "fake", workspace: ws, instructions: "w", files: {}, outFile: "letter.json", validate: (raw) => ({ ok: true, value: raw as { text: string }, warnings: [] }), timeoutMs: 20000 }),
      produce: async () => ({ tex: "", pdf: new Uint8Array([1]), pages: 1, fill: null, facts: facts(), text: "letter" }),
      reviewFiles: { "job.md": "JD" },
    });
    expect(calls()).toEqual(["cover-write", "cover-review-1"]);
    expect(r.review).toEqual(coverPass);
    const ws = join(runDir(), "cover-review-1");
    expect(existsSync(join(ws, "profile.json"))).toBe(false);
    const instr = readFileSync(join(ws, "instructions.md"), "utf8");
    expect(instr).toContain("templated");
    expect(instr).toContain("no access to the candidate's profile");
  });

  test("cover-letter review missing voice/templated is rejected", async () => {
    script({ "cover-write": [{ "out/letter.json": { text: "v1" } }], "cover-review-1": [rev(pass)] });
    const r = await refine<{ text: string }>({
      kind: "cover-letter",
      runsDir: join(dir, "runs"),
      runId: "r1",
      adapter,
      name: "fake",
      timeoutMs: 20000,
      maxRounds: 1,
      write: (ws) =>
        runAgentStep({ adapter, name: "fake", workspace: ws, instructions: "w", files: {}, outFile: "letter.json", validate: (raw) => ({ ok: true, value: raw as { text: string }, warnings: [] }), timeoutMs: 20000 }),
      produce: async () => ({ tex: "", pdf: new Uint8Array([1]), pages: 1, fill: null, facts: facts(), text: "letter" }),
      reviewFiles: { "job.md": "JD" },
    });
    expect(r.warnings[0]).toStartWith("review failed: ");
    expect(readFileSync(join(runDir(), "cover-review-1", "errors.md"), "utf8")).toContain("voice");
  });
});

describe("revision helpers", () => {
  test("revisionInstructions carries the revision rules", async () => {
    const t = await revisionInstructions();
    expect(t).toContain(
      "Read previous.json, review.json, hard-facts.json. Address every request that can be met truthfully. A request you can't meet truthfully becomes a gap, not a claim. Fix overflow by trimming the weakest bullets; on underflow, add only supported content.",
    );
  });

  test("writeRevisionFiles writes previous, review and hard facts", () => {
    writeRevisionFiles(dir, { previous: resume, review: revise, facts: facts() });
    expect(JSON.parse(readFileSync(join(dir, "previous.json"), "utf8"))).toEqual(resume);
    expect(JSON.parse(readFileSync(join(dir, "review.json"), "utf8"))).toEqual(revise);
    expect(JSON.parse(readFileSync(join(dir, "hard-facts.json"), "utf8"))).toEqual(facts());
  });
});

describe("validateReview", () => {
  const cover = { ...pass, scores: { ...pass.scores, voice: 4 }, templated: false };
  const errs = (raw: unknown, kind: "resume" | "cover-letter" = "resume") => {
    const r = validateReview(raw, kind);
    return r.ok ? [] : r.errors;
  };

  test("accepts the fixtures", () => {
    expect(validateReview(pass, "resume")).toEqual({ ok: true, value: pass, warnings: [] });
    expect(validateReview(revise, "resume").ok).toBe(true);
    expect(validateReview(cover, "cover-letter").ok).toBe(true);
  });

  test("schema errors", () => {
    expect(errs({ ...pass, scores: { ...pass.scores, relevance: 6 } }).join()).toContain("scores.relevance");
    expect(errs({ ...pass, scores: { ...pass.scores, impact: 2.5 } }).join()).toContain("scores.impact");
    expect(errs({ ...pass, verdict: "ok" }).join()).toContain("verdict");
    expect(errs({ ...pass, impression: "" }).join()).toContain("impression");
  });

  test("revise requires at least one request", () => {
    expect(errs({ ...revise, requests: [] }).join()).toContain("requests");
    expect(errs({ ...revise, requests: ["  "] }).join()).toContain("requests");
  });

  test("R16: pass is invalid only with a score of 2 or lower; a 3 may pass", () => {
    expect(errs({ ...pass, scores: { ...pass.scores, keywords: 3 } })).toEqual([]);
    expect(errs({ ...pass, scores: { ...pass.scores, impact: 3, keywords: 3 }, requests: ["Polish: tighten the summary."] })).toEqual([]);
    expect(errs({ ...pass, scores: { ...pass.scores, keywords: 2 } })).toEqual(['verdict: "pass" with keywords scored 2 or lower; use "revise"']);
    expect(errs({ ...pass, scores: { ...pass.scores, relevance: 1, impact: 2 } })).toEqual(['verdict: "pass" with relevance, impact scored 2 or lower; use "revise"']);
    // voice is only a cover-letter score
    expect(errs({ ...pass, scores: { ...pass.scores, voice: 1 } })).toEqual([]);
    expect(errs({ ...cover, scores: { ...cover.scores, voice: 3 } }, "cover-letter")).toEqual([]);
  });

  test("cover-letter reviews require voice and templated; templated must revise", () => {
    expect(errs(pass, "cover-letter").join()).toContain("scores.voice");
    expect(errs({ ...pass, scores: cover.scores }, "cover-letter").join()).toContain("templated");
    expect(errs({ ...cover, templated: true }, "cover-letter").join()).toContain("templated");
    expect(errs({ ...cover, templated: true, verdict: "revise", requests: ["Paragraph 1: open with the dispatch detail from the posting."] }, "cover-letter")).toEqual([]);
    expect(errs({ ...cover, scores: { ...cover.scores, voice: 2 } }, "cover-letter").join()).toContain("verdict");
  });
});
