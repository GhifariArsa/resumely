import { test, expect, describe, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostAllowed, newToken, originAllowed, parseFilePath, postAllowed, resolveInside, tokenMatches } from "../src/ui/security";

describe("newToken", () => {
  test("32 random bytes, base64url", () => {
    const a = newToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(a);
  });
});

describe("hostAllowed", () => {
  test("accepts loopback names with the exact port, case-insensitive", () => {
    expect(hostAllowed("127.0.0.1:5000", 5000)).toBe(true);
    expect(hostAllowed("LOCALHOST:5000", 5000)).toBe(true);
  });
  test("refuses other ports, other hosts, a missing port and a missing header", () => {
    expect(hostAllowed("127.0.0.1:5001", 5000)).toBe(false);
    expect(hostAllowed("evil.test", 5000)).toBe(false);
    expect(hostAllowed(null, 5000)).toBe(false);
    expect(hostAllowed("127.0.0.1", 5000)).toBe(false);
    expect(hostAllowed("evil.test:5000", 5000)).toBe(false);
  });
});

describe("originAllowed / postAllowed", () => {
  const p = 5000;
  test("absent or local origin is allowed", () => {
    expect(originAllowed(null, p)).toBe(true);
    expect(originAllowed(`http://localhost:${p}`, p)).toBe(true);
    expect(originAllowed(`http://127.0.0.1:${p}`, p)).toBe(true);
  });
  test("opaque, foreign, https or other-port origins are refused", () => {
    expect(originAllowed("null", p)).toBe(false);
    expect(originAllowed("http://evil.test", p)).toBe(false);
    expect(originAllowed(`https://127.0.0.1:${p}`, p)).toBe(false);
    expect(originAllowed(`http://127.0.0.1:${p + 1}`, p)).toBe(false);
  });
  test("postAllowed also refuses Sec-Fetch-Site: cross-site", () => {
    const req = (h: Record<string, string>) => new Request(`http://127.0.0.1:${p}/x`, { method: "POST", headers: h });
    expect(postAllowed(req({}), p)).toBe(true);
    expect(postAllowed(req({ "sec-fetch-site": "same-origin" }), p)).toBe(true);
    expect(postAllowed(req({ "sec-fetch-site": "cross-site" }), p)).toBe(false);
    expect(postAllowed(req({ origin: "null" }), p)).toBe(false);
    expect(postAllowed(req({ origin: "http://evil.test" }), p)).toBe(false);
  });
});

describe("tokenMatches", () => {
  test("only the exact string matches", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abd", "abc")).toBe(false);
    expect(tokenMatches("ab", "abc")).toBe(false);
    expect(tokenMatches(null, "abc")).toBe(false);
    expect(tokenMatches(new File(["abc"], "abc"), "abc")).toBe(false);
  });
});

describe("parseFilePath", () => {
  test.each([
    "/files/a/resume/v1/../x.pdf",
    "/files/a/resume/v1/..%2fx.pdf",
    "/files/%2e%2e/resume/v1/x.pdf",
    "/files/a/job/v1/raw.md",
    "/files/a/resume/v0/x.pdf",
    "/files/a/resume/v1/x.toml",
    "/files/a/resume/v1/.x.pdf",
    "/files/a/resume/v1/x.pdf%00.json",
    "/files/a/resume/v1/%E0%A4%A.pdf",
    "/files/a/resume/v1",
    "/files/a/resume/v1/x.pdf/extra",
    "/files/a%2fb/resume/v1/x.pdf",
    "/files/a%5cb/resume/v1/x.pdf",
    "/files/.a/resume/v1/x.pdf",
    "/files//resume/v1/x.pdf",
    "/files/a/resume/v01/x.pdf",
    "/assets/a/resume/v1/x.pdf",
  ])("%s → null", (p) => {
    expect(parseFilePath(p)).toBeNull();
  });

  test("parses a valid path", () => {
    expect(parseFilePath("/files/2026-01-01-a-b/cover-letter/v12/J_E.pdf")).toEqual({
      slug: "2026-01-01-a-b",
      kind: "cover-letter",
      version: 12,
      name: "J_E.pdf",
    });
    expect(parseFilePath("/files/a/resume/v2/meta.json")?.name).toBe("meta.json");
  });
});

describe("resolveInside", () => {
  let base: string;
  let outside: string;
  beforeAll(() => {
    const tmp = mkdtempSync(join(tmpdir(), "ui-sec-"));
    base = join(tmp, "base");
    outside = join(tmp, "secret.txt");
    mkdirSync(join(base, "a", "dir"), { recursive: true });
    writeFileSync(join(base, "a", "ok.pdf"), "%PDF");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(base, "a", "leak.json"));
  });

  test("a file inside the base resolves to its real path", () => {
    const got = resolveInside(base, ["a", "ok.pdf"]);
    expect(got).not.toBeNull();
    expect(got!.endsWith(join("a", "ok.pdf"))).toBe(true);
  });
  test("a symlink pointing outside the base is refused", () => {
    expect(resolveInside(base, ["a", "leak.json"])).toBeNull();
  });
  test("a missing file is refused", () => {
    expect(resolveInside(base, ["a", "missing.pdf"])).toBeNull();
  });
  test("a directory is refused", () => {
    expect(resolveInside(base, ["a", "dir"])).toBeNull();
  });
  test("traversal segments are refused", () => {
    expect(resolveInside(base, ["..", "secret.txt"])).toBeNull();
  });
});
