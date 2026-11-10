import { test, expect } from "bun:test";
import { scanClaims } from "../src/checks/fabrication";

const src = ["Rebuilt dashboard, 60% faster; 2M events", "Atlas Labs"];

test("sourced numbers and proper nouns give no findings", () => {
  expect(scanClaims("Cut load time by 60% for 2M users at Atlas Labs", src)).toEqual([]);
});

test("unsourced number and proper noun are returned", () => {
  expect(scanClaims("Increased revenue 30% at Google", src)).toEqual(["30%", "Google"]);
});

test("sentence-initial words are not flagged; bullet start counts", () => {
  expect(scanClaims("Built tools. Shipped fast! Delivered Rust", ["x"])).toEqual(["Rust"]);
});

test("C# and Node.js are sourced by whole token", () => {
  expect(scanClaims("Wrote a C# layer on Node.js", ["uses C# and node.js"])).toEqual([]);
  expect(scanClaims("Wrote a C# layer", ["C++ only"])).toEqual(["C#"]);
});

test("trailing sentence period is stripped", () => {
  expect(scanClaims("Moved to Postgres.", ["Postgres"])).toEqual([]);
});

test("generic capitalised words and stop words are ignored", () => {
  expect(scanClaims("Led REST API work as Senior Engineer on the Team in March", ["x"])).toEqual([]);
});

test("number forms compare by digits", () => {
  expect(scanClaims("Saved $5M", ["spend of 5M"])).toEqual([]);
  expect(scanClaims("Served 2,000 users", ["2000 users"])).toEqual([]);
});

const none = ["x"];
test("units matter", () => {
  expect(scanClaims("Reduced latency by 40%", ["latency 40ms"])).toEqual(["40%"]);
  expect(scanClaims("Saved $5M", ["team of 5"])).toEqual(["$5M"]);
  expect(scanClaims("Served 1.2k users", ["12 services"])).toEqual(["1.2k"]);
  expect(scanClaims("Cut it by 4 mobile apps", ["4 apps"])).toEqual([]);
});

test("number words, percent words and years normalise", () => {
  expect(scanClaims("Grew to 3 engineers", ["three engineers"])).toEqual([]);
  expect(scanClaims("Raised 40%", ["40 percent"])).toEqual([]);
  expect(scanClaims("Served 2M users", ["2 million users"])).toEqual([]);
  expect(scanClaims("Owned it since 2023", ["2023"])).toEqual([]);
});

test("sentence-initial exemption is limited to verbs and stop words", () => {
  expect(scanClaims("Kafka pipelines scaled to millions", none)).toEqual(["Kafka"]);
  expect(scanClaims("Led migration. Kafka now handles events", none)).toEqual(["Kafka"]);
  expect(scanClaims("Integrated payments (e.g. Stripe) and invoicing", none)).toEqual(["Stripe"]);
  expect(scanClaims("Built X; Reduced Y", none)).toEqual([]);
  expect(scanClaims("Improving Rust tooling", none)).toEqual(["Rust"]);
});

test("generic acronyms, plurals, quarters and percentiles are ignored", () => {
  expect(scanClaims("Shipped APIs and SDKs with JSON over HTTPS in Q3, p95 under load", none)).toEqual([]);
});

test("short proper nouns match case-sensitively", () => {
  expect(scanClaims("Used Go", ["go live"])).toEqual(["Go"]);
  expect(scanClaims("Used Go", ["Go services"])).toEqual([]);
});

test("token boundaries are dot-aware", () => {
  expect(scanClaims("Used Next daily", ["Next.js"])).toEqual(["Next"]);
  expect(scanClaims("Used NET daily", ["ASP.NET"])).toEqual(["NET"]);
  expect(scanClaims("Used Node.js daily", ["Node.js"])).toEqual([]);
});

test("numbers inside reported proper nouns are not reported twice", () => {
  expect(scanClaims("Moved to v2.0 stack", none)).toEqual(["v2.0"]);
  expect(scanClaims("Stored in S3", none)).toEqual(["S3"]);
  expect(scanClaims("Stored backups in S3, saving 3 hours", none)).toEqual(["3", "S3"]);
});

test(".NET is one token", () => {
  expect(scanClaims("Built services in .NET", ["Services in .NET and C#"])).toEqual([]);
  expect(scanClaims("Built services in .NET", ["ASP.NET"])).toEqual([".NET"]);
});

test("number words in generated text are not numbers", () => {
  expect(scanClaims("Delivered zero-downtime migrations", none)).toEqual([]);
  expect(scanClaims("Built a one-click deploy", none)).toEqual([]);
  expect(scanClaims("Hired twenty-five engineers", ["25 engineers"])).toEqual([]);
});

test("hyphenated and inflected sentence openers", () => {
  for (const t of ["Co-led the team", "Re-architected billing", "End-to-end tests shipped", "Leads reviews", "Rebuilt search", "Stood up CI", "Also fixed bugs"]) {
    expect(scanClaims(t, none)).toEqual([]);
  }
});

test("x and multiplication sign are the same unit; x2 is a number", () => {
  expect(scanClaims("Grew 2x", ["2×"])).toEqual([]);
  expect(scanClaims("Grew x2", none)).toEqual(["2x"]);
});

test("hyphenated openers: tech prefixes are still checked", () => {
  expect(scanClaims("Kafka-based pipelines for billing", none)).toEqual(["Kafka"]);
  expect(scanClaims("React-powered dashboard", none)).toEqual(["React"]);
  expect(scanClaims("Kubernetes-hosted services", none)).toEqual(["Kubernetes"]);
  for (const t of ["Co-led the team", "Re-architected billing", "End-to-end tests", "Co-founded a startup", "Re-wrote search", "Co-ran reviews"]) {
    expect(scanClaims(t, none)).toEqual([]);
  }
  expect(scanClaims("Re-wrote the ingestion service in Go", ["Go"])).toEqual([]);
});

test("leading-dot decimals are numbers", () => {
  expect(scanClaims("Cut latency to .5 seconds", ["0.5 seconds"])).toEqual([]);
  expect(scanClaims("Cut latency to .5 seconds", none)).toEqual(["0.5"]);
});

test("x86 is a name, x2 a multiplier", () => {
  expect(scanClaims("Optimised x86 kernels", ["x86"])).toEqual([]);
  expect(scanClaims("Optimised x86 kernels", none)).toEqual(["x86"]);
  expect(scanClaims("Grew x10", none)).toEqual(["10x"]);
});

// R14: false positives seen in real runs. Each string is truthful against its sources and must pass.
const real = ["Skills include TypeScript, Node.js and PostgreSQL", "carrier payouts and load matching", "slow queries; models for billing events"];

test("R14: structural nouns are generic", () => {
  expect(scanClaims("Skills include TypeScript, Node.js and PostgreSQL.", real)).toEqual([]);
  for (const w of ["Experience", "Projects", "Summary", "Education", "Backend", "Frontend", "Platform", "Engineering"]) {
    expect(scanClaims(`Shipped ${w} work`, none)).toEqual([]);
  }
});

test("R14: hyphenated openers with a known first part are exempt whatever the last part", () => {
  for (const t of ["Cross-functional work with product teams", "Real-time tracking of shipments", "Open-source bookkeeping library", "Hands-on with production systems", "Long-running jobs", "Self-serve dashboards", "Event-driven ingestion"]) {
    expect(scanClaims(t, none)).toEqual([]);
  }
});

test("R14: sentence-initial -ly adverbs are exempt", () => {
  expect(scanClaims("Previously built REST services in Go.", ["Go"])).toEqual([]);
  expect(scanClaims("Led billing. Recently moved to Postgres.", ["Postgres"])).toEqual([]);
});

test("R14: a sentence-initial Titlecase word is exempt when its lowercase form is sourced or used elsewhere", () => {
  expect(scanClaims("Carrier payouts are the part of the role I know best.", real)).toEqual([]);
  expect(scanClaims("Models for billing events were rebuilt.", real)).toEqual([]);
  expect(scanClaims("Slow queries were the bottleneck.", real)).toEqual([]);
  expect(scanClaims("Slow builds hurt.", none, { context: "fixed the slow parts" })).toEqual([]);
  expect(scanClaims("Slow builds hurt.", none)).toEqual(["Slow"]);
  // capitalised-only occurrences don't count: "Carrier" must appear lowercase
  expect(scanClaims("Carrier payouts", none, { context: "Carrier Inc" })).toEqual(["Carrier"]);
});

test("R14: tech names at sentence start still fail", () => {
  expect(scanClaims("Kafka pipelines scaled to millions", none)).toEqual(["Kafka"]);
  expect(scanClaims("Kafka-based pipelines for billing", none)).toEqual(["Kafka"]);
  expect(scanClaims("React-powered dashboard", none)).toEqual(["React"]);
  expect(scanClaims("Integrated payments (e.g. Stripe) and invoicing", none)).toEqual(["Stripe"]);
  expect(scanClaims("Stripe billing shipped.", ["billing"], { context: "billing" })).toEqual(["Stripe"]);
  // internal capitals / digits never take the lowercase exemption
  expect(scanClaims("PostgreSQL tuning.", none, { context: "postgresql tuning" })).toEqual(["PostgreSQL"]);
  expect(scanClaims("Go2 services.", none, { context: "go2" })).toEqual(["Go2"]);
});

test("R9: short names (≤3 chars) never take the lowercase exemption at sentence start", () => {
  expect(scanClaims("Go services handle billing.", ["let's go live"])).toContain("Go");
  expect(scanClaims("Go services handle billing.", ["owned the go-live"])).toContain("Go");
  expect(scanClaims("Go services handle billing.", [], { context: "ready to go" })).toContain("Go");
  expect(scanClaims("Go services handle billing.", ["Built services in Go"])).toEqual([]);
});
