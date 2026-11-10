import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isConfidential, renderCompanyMd, runResearch } from "../src/pipeline/research";
import { validateResearch } from "../src/pipeline/validate";
import type { ParsedJob } from "../src/pipeline/schemas";

const fx = join(import.meta.dir, "fixtures");
const company = JSON.parse(readFileSync(join(fx, "company.json"), "utf8"));
const job: ParsedJob = { company: "Atlas Freight", role: "Backend", requirements: [], nice_to_haves: [], keywords: [], language: "en" };
const adapter = { command: ["bun", join(fx, "fake-harness.ts"), "{workspace}"] };

let dir: string;
const saved = { s: process.env.FAKE_HARNESS_SCRIPT, f: process.env.FAKE_HARNESS_FAIL_STEP };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "resumely-research-"));
  mkdirSync(join(dir, "app/job"), { recursive: true });
  const p = join(dir, "script.json");
  writeFileSync(p, JSON.stringify({ research: [{ "out/company.json": company }] }));
  process.env.FAKE_HARNESS_SCRIPT = p;
  delete process.env.FAKE_HARNESS_FAIL_STEP;
});
afterEach(() => {
  for (const [k, v] of [["FAKE_HARNESS_SCRIPT", saved.s], ["FAKE_HARNESS_FAIL_STEP", saved.f]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});
const calls = () => (existsSync(join(dir, "script.json.calls")) ? readFileSync(join(dir, "script.json.calls"), "utf8") : "");
const go = (over: Partial<Parameters<typeof runResearch>[0]> = {}) =>
  runResearch({ adapter, name: "fake", runsDir: join(dir, "runs"), runId: "r1", appDir: join(dir, "app"), job, jobText: "JD", timeoutMs: 20000, ...over });

describe("runResearch", () => {
  test("happy path writes company.json/md, no profile in workspace; second run reuses", async () => {
    const r = await go();
    expect(r.research).toEqual(company);
    expect(r.warning).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, "app/job/company.json"), "utf8"))).toEqual(company);
    expect(readFileSync(join(dir, "app/job/company.md"), "utf8")).toBe(renderCompanyMd(company));
    expect(calls()).toBe("research\n");
    const ws = join(dir, "runs/r1/research");
    expect(existsSync(join(ws, "profile.json"))).toBe(false);
    expect(readdirSync(ws)).toEqual(expect.arrayContaining(["job.md", "parsed-job.json", "company.schema.json"]));
    const again = await go({ runId: "r2" });
    expect(again.research).toEqual(company);
    expect(calls()).toBe("research\n");
  });

  test("confidential: warning, no call", async () => {
    const r = await go({ job: { ...job, company: "Confidential (via Hays)" } });
    expect(r).toEqual({ research: null, warning: "research skipped: confidential/agency posting" });
    expect(calls()).toBe("");
  });

  test("null adapter: warning", async () => {
    const r = await go({ adapter: null });
    expect(r).toEqual({ research: null, warning: "research skipped: fake has no web tools (set adapters.fake.research_command)" });
    expect(calls()).toBe("");
  });

  test("failing step becomes a warning with logs", async () => {
    process.env.FAKE_HARNESS_FAIL_STEP = "research";
    const r = await go();
    expect(r.research).toBeNull();
    expect(r.warning).toContain("research failed:");
    expect(r.warning).toContain("logs:");
    expect(calls()).toContain("research\n");
    expect(existsSync(join(dir, "app/job/company.json"))).toBe(false);
  });

  test("invalid output on all attempts becomes a warning", async () => {
    writeFileSync(join(dir, "script.json"), JSON.stringify({ research: [{ "out/company.json": "INVALID" }] }));
    const r = await go();
    expect(r.research).toBeNull();
    expect(r.warning).toContain("research failed:");
  });
});

describe("isConfidential", () => {
  test.each(["Confidential (via Hays)", "Stealth Startup", "Undisclosed fintech", "Acme via Robert Half Recruiting"])("%s", (c) => {
    expect(isConfidential({ ...job, company: c })).toBe(true);
  });
  test("Atlas Freight is not", () => expect(isConfidential(job)).toBe(false));
});

describe("validateResearch", () => {
  test("accepts fixture", () => expect(validateResearch(company).ok).toBe(true));
  test("rejects source_url not in sources", () => {
    const bad = structuredClone(company);
    bad.facts[0].source_url = "https://other.example/x";
    const r = validateResearch(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain("not listed in sources");
  });
  test("rejects ftp url", () => {
    const bad = structuredClone(company);
    bad.facts[0].source_url = "ftp://x.example/a";
    bad.sources.push("ftp://x.example/a");
    const r = validateResearch(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain("http(s)");
  });
  test("rejects duplicate ids, bad id, unsupported chars", () => {
    const bad = structuredClone(company);
    bad.facts[1].id = "co-1";
    expect(validateResearch(bad).ok).toBe(false);
    const bad2 = structuredClone(company);
    bad2.facts[0].id = "x1";
    expect(validateResearch(bad2).ok).toBe(false);
    const bad3 = structuredClone(company);
    bad3.facts[0].text = "Uses \u{1F680} rockets";
    expect(validateResearch(bad3).ok).toBe(false);
  });
});

test("renderCompanyMd is deterministic and ordered", () => {
  const md = renderCompanyMd(company);
  expect(md).toBe(renderCompanyMd(company));
  expect(md).toBe(
    "# Atlas Freight\n\nAtlas Freight runs freight logistics software for mid-size carriers.\n\n## Facts\n\n" +
      "- Atlas Freight builds dispatch software for regional carriers. [co-1](https://atlasfreight.example/product)\n" +
      "- The engineering team runs its event pipeline on Kafka. [co-2](https://atlasfreight.example/blog/events)\n\n" +
      "## Sources\n\n- https://atlasfreight.example/product\n- https://atlasfreight.example/blog/events\n",
  );
});
