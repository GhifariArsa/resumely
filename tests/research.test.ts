import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  runResearch({ adapter, name: "fake", runsDir: join(dir, "runs"), runId: "r1", appDir: join(dir, "app"), job, timeoutMs: 20000, ...over });

describe("runResearch", () => {
  test("happy path writes company.json/md, no profile in workspace; second run reuses", async () => {
    const r = await go();
    expect(r.research).toEqual(company);
    expect(r.status).toBe("used");
    expect(r.warning).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, "app/job/company.json"), "utf8"))).toEqual(company);
    expect(readFileSync(join(dir, "app/job/company.md"), "utf8")).toBe(renderCompanyMd(company));
    expect(calls()).toBe("research\n");
    // the run keeps the logs and output, not the inputs
    const ws = join(dir, "runs/r1/research");
    expect(readdirSync(ws).sort()).toEqual(["out", "stderr.log", "stdout.log"]);
    expect(JSON.parse(readFileSync(join(ws, "out/company.json"), "utf8"))).toEqual(company);
    const again = await go({ runId: "r2" });
    expect(again.research).toEqual(company);
    expect(again.status).toBe("used");
    expect(calls()).toBe("research\n");
  });

  test("confidential: warning, no call", async () => {
    const r = await go({ job: { ...job, company: "Confidential (via Hays)" } });
    expect(r).toEqual({ research: null, status: "skipped", warning: "research skipped: confidential/agency posting" });
    expect(calls()).toBe("");
  });

  test("null adapter: warning", async () => {
    const r = await go({ adapter: null });
    expect(r).toEqual({ research: null, status: "skipped", warning: "research skipped: fake has no web tools (set adapters.fake.research_command)" });
    expect(calls()).toBe("");
  });

  test("failing step becomes a warning with logs", async () => {
    process.env.FAKE_HARNESS_FAIL_STEP = "research";
    const r = await go();
    expect(r.research).toBeNull();
    expect(r.status).toBe("failed");
    expect(r.warning).toContain("research failed:");
    expect(r.warning).toContain("logs:");
    expect(calls()).toContain("research\n");
    expect(existsSync(join(dir, "app/job/company.json"))).toBe(false);
  });

  test("invalid output on all attempts becomes a warning", async () => {
    writeFileSync(join(dir, "script.json"), JSON.stringify({ research: [{ "out/company.json": "INVALID" }] }));
    const r = await go();
    expect(r.research).toBeNull();
    expect(r.status).toBe("failed");
    expect(r.warning).toContain("research failed:");
  });
});

describe("R18: research inputs", () => {
  const listing = () => {
    const p = join(dir, "ls.jsonl");
    return readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { step: string; workspace: string; files: string[]; target?: unknown });
  };
  beforeEach(() => (process.env.FAKE_HARNESS_LS = join(dir, "ls.jsonl")));
  afterEach(() => delete process.env.FAKE_HARNESS_LS);

  test("the workspace holds only target.json and the schema, in the OS temp dir outside the data root", async () => {
    const r = await go({ url: "https://jobs.example/atlas/123", job: { ...job, location: "Remote (Canada)" } });
    expect(r.status).toBe("used");
    const [seen] = listing();
    expect(seen!.files).toEqual(["company.schema.json", "instructions.md", "out", "target.json"]);
    expect(seen!.target).toEqual({ company: "Atlas Freight", role: "Backend", location: "Remote (Canada)", url: "https://jobs.example/atlas/123" });
    expect(seen!.workspace.startsWith(realpathSync(tmpdir())) || seen!.workspace.startsWith(tmpdir())).toBe(true);
    expect(seen!.workspace.startsWith(dir)).toBe(false);
    expect(existsSync(seen!.workspace)).toBe(false);
  });
  test("target.json omits location and url when unknown", async () => {
    await go();
    expect(listing()[0]!.target).toEqual({ company: "Atlas Freight", role: "Backend" });
  });
  test("logs and errors are copied back into the run on failure", async () => {
    writeFileSync(join(dir, "script.json"), JSON.stringify({ research: [{ "out/company.json": "INVALID", $stderr: "boom" }] }));
    const r = await go();
    expect(r.status).toBe("failed");
    const ws = join(dir, "runs/r1/research");
    expect(r.warning).toContain(`(logs: ${ws})`);
    const files = readdirSync(ws).sort();
    expect(files).toEqual(["errors.md", "out", "stderr.2.log", "stderr.3.log", "stderr.log", "stdout.2.log", "stdout.3.log", "stdout.log"]);
    expect(readFileSync(join(ws, "stderr.log"), "utf8")).toContain("boom");
    expect(readFileSync(join(ws, "errors.md"), "utf8")).toContain("not valid JSON");
    expect(existsSync(listing()[0]!.workspace)).toBe(false);
  });
  test("logs are copied back when the harness fails", async () => {
    process.env.FAKE_HARNESS_FAIL_STEP = "research";
    const r = await go();
    expect(r.status).toBe("failed");
    expect(readFileSync(join(dir, "runs/r1/research/stderr.log"), "utf8")).toContain("usage limit");
  });
});

describe("R17: nothing found", () => {
  const empty = { company: "Atlas Freight", summary: "No verifiable sources for this company.", facts: [], sources: [] };
  test("an empty fact list is valid", () => expect(validateResearch(empty).ok).toBe(true));
  test("runResearch returns none_found without a warning, and reuses it", async () => {
    writeFileSync(join(dir, "script.json"), JSON.stringify({ research: [{ "out/company.json": empty }] }));
    const r = await go();
    expect(r).toEqual({ research: null, status: "none_found" });
    expect(JSON.parse(readFileSync(join(dir, "app/job/company.json"), "utf8"))).toEqual(empty);
    const again = await go({ runId: "r2" });
    expect(again).toEqual({ research: null, status: "none_found" });
    expect(calls()).toBe("research\n");
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
