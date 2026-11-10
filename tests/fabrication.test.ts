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
});
