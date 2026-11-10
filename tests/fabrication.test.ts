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
  expect(scanClaims("Built tools. Shipped fast! Then Rust", ["x"])).toEqual(["Rust"]);
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
