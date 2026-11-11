import { test, expect, describe, beforeAll, afterAll, spyOn } from "bun:test";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "../src/errors";
import { setStatus } from "../src/application/tracking";
import { getApplication } from "../src/ui/data";
import { layout } from "../src/paths";
import { startUiServer, type UiServer } from "../src/ui/server";
import { makeUiRoot } from "./fixtures/ui-root";
import { rawRequest } from "./fixtures/raw-http";

const PDF_NAME = "Jordan_Example_Resume_AtlasFreight.pdf";

let fx: ReturnType<typeof makeUiRoot>;
let server: UiServer;
const get = (path: string, init?: RequestInit) => fetch(server.url + path.replace(/^\//, ""), init);
const raw = (path: string, host = `127.0.0.1:${server.port}`, method = "GET") => rawRequest(server.port, `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\n`);

beforeAll(() => {
  fx = makeUiRoot();
  server = startUiServer({ root: fx.root, port: 0, token: "tok" });
});
afterAll(async () => {
  await server.stop();
});

describe("pages", () => {
  test("GET / renders the board with security headers", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/html");
    const body = await res.text();
    expect(body).toContain("Atlas Freight");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("server.url is loopback", () => {
    expect(server.url).toStartWith("http://127.0.0.1:");
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/`);
    expect(server.token).toBe("tok");
  });

  test("list view with a status filter", async () => {
    const body = await (await get("/?view=list&status=applied")).text();
    expect(body).toContain("<table");
    expect(body).toContain(`href="/app/${fx.atlas}"`);
    expect(body).not.toContain("Orbit");
  });

  test("an unknown status is ignored and a company filter applies", async () => {
    const body = await (await get("/?view=list&status=bogus")).text();
    expect(body).toContain("Orbit");
    expect(body).toContain("Atlas Freight");
    const byCompany = await (await get("/?view=list&company=atlas")).text();
    expect(byCompany).toContain("Atlas Freight");
    expect(byCompany).not.toContain("Orbit");
  });

  test("filters that match nothing still know there are applications", async () => {
    const body = await (await get("/?company=zzz")).text();
    expect(body).toContain("No applications match these filters");
  });

  test("GET /profile", async () => {
    const res = await get("/profile");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Jordan Example");
  });

  test("GET /app/<slug> and its version params", async () => {
    const res = await get(`/app/${fx.atlas}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<iframe");
    expect((await get(`/app/${fx.atlas}?kind=cover-letter&v=1`)).status).toBe(200);
    for (const q of ["?v=9", "?kind=nope", "?v=1x"]) {
      const bad = await get(`/app/${fx.atlas}${q}`);
      expect(bad.status).toBe(404);
      expect(await bad.text()).toContain("No application or version matches this link.");
    }
    expect((await get("/app/atlas")).status).toBe(404);
    const empty = await get(`/app/${fx.empty}`);
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain("No documents yet");
  });

  test("a malformed slug escape is a 404, not a 500", async () => {
    expect((await raw("/app/%E0%A4%A")).status).toBe(404);
  });

  test("GET /nope is an HTML 404", async () => {
    const res = await get("/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toStartWith("text/html");
    expect(await res.text()).toContain("<h1>Not found</h1>");
  });

  test("PUT / is 405 with Allow", async () => {
    const res = await get("/", { method: "PUT" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, POST");
  });

  test("HEAD / is answered like GET", async () => {
    const res = await get("/", { method: "HEAD" });
    expect(res.status).toBe(200);
  });
});

describe("assets", () => {
  test.each([
    ["base.css", "text/css"],
    ["board.css", "text/css"],
    ["application.css", "text/css"],
    ["profile.css", "text/css"],
    ["application.js", "text/javascript"],
  ])("%s is served as %s", async (name, type) => {
    const res = await get(`/assets/${name}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith(type);
    expect((await res.text()).length).toBeGreaterThan(0);
  });

  test("every asset a page references is served", async () => {
    const pages = ["/", "/profile", `/app/${fx.atlas}`, "/nope"];
    const refs = new Set<string>();
    for (const p of pages) for (const m of (await (await get(p)).text()).matchAll(/(?:href|src)="(\/assets\/[^"]+)"/g)) refs.add(m[1]!);
    expect(refs.size).toBeGreaterThanOrEqual(5);
    for (const r of refs) expect({ r, status: (await get(r)).status }).toEqual({ r, status: 200 });
  });

  test("unknown assets are 404", async () => {
    expect((await get("/assets/nope.css")).status).toBe(404);
  });
});

describe("files", () => {
  test("serves a version PDF inline", async () => {
    const res = await get(`/files/${fx.atlas}/resume/v2/${PDF_NAME}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="${PDF_NAME}"`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(await res.text()).toStartWith("%PDF");
  });

  test("serves version JSON", async () => {
    const res = await get(`/files/${fx.atlas}/resume/v2/meta.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toHaveProperty("template");
  });

  test("a missing file or unknown app is 404", async () => {
    expect((await get(`/files/${fx.atlas}/resume/v2/missing.pdf`)).status).toBe(404);
    expect((await get(`/files/nope/resume/v1/${PDF_NAME}`)).status).toBe(404);
  });

  test("traversal attempts are 404 and leak nothing", async () => {
    for (const p of [
      "/files/../config.toml",
      "/files/%2e%2e/%2e%2e/config.toml",
      `/files/${fx.atlas}/resume/v1/..%2f..%2f..%2f..%2fconfig.toml`,
      `/files/${fx.atlas}/job/v1/raw.md`,
      `/files/${fx.atlas}/job/../../../config.toml`,
      "/assets/..%2f..%2f..%2fpackage.json",
      "/assets/../../../package.json",
    ]) {
      const res = await raw(p);
      expect({ p, status: res.status }).toEqual({ p, status: 404 });
      expect(res.body).not.toContain("harness");
      expect(res.body).not.toContain('"dependencies"');
    }
  });

  test("a symlink out of the data root is 404", async () => {
    symlinkSync(layout(fx.root).config, join(layout(fx.root).applications, fx.atlas, "resume/v1/leak.json"));
    const res = await raw(`/files/${fx.atlas}/resume/v1/leak.json`);
    expect(res.status).toBe(404);
    expect(res.body).not.toContain("harness");
  });
});

describe("guards", () => {
  test("Host must be loopback with this port", async () => {
    const evil = await raw("/", "evil.test");
    expect(evil.status).toBe(403);
    expect(evil.body).toContain("Forbidden: unexpected Host header");
    expect((await raw("/", `localhost:${server.port}`)).status).toBe(200);
    expect((await raw("/", `127.0.0.1:${server.port + 1}`)).status).toBe(403);
    expect((await raw(`/files/${fx.atlas}/resume/v2/${PDF_NAME}`, "evil.test")).status).toBe(403);
  });

  test("a foreign Origin is refused on GET", async () => {
    const res = await get("/", { headers: { origin: "http://evil.test" } });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden: cross-origin request");
  });

  test("POSTs need the token, a local origin and no cross-site fetch", async () => {
    const toml = join(layout(fx.root).applications, fx.atlas, "application.toml");
    const before = readFileSync(toml);
    const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
      get(`/app/${fx.atlas}/note`, { method: "POST", body: new URLSearchParams(fields), headers, redirect: "manual" });

    for (const [fields, headers] of [
      [{ text: "x" }, {}],
      [{ text: "x", _token: "wrong" }, {}],
      [{ text: "x", _token: "tok" }, { origin: "http://evil.test" }],
      [{ text: "x", _token: "tok" }, { "sec-fetch-site": "cross-site" }],
      [{ text: "x", _token: "tok" }, { origin: "null" }],
    ] as const) {
      const res = await post(fields, headers);
      expect(res.status).toBe(403);
    }
    const bad = await post({ text: "x" });
    expect(await bad.text()).toBe("Forbidden: missing or invalid token");

    const notForm = await get(`/app/${fx.atlas}/note`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(notForm.status).toBe(403);

    expect(readFileSync(toml).equals(before)).toBe(true);

    const ok = await post({ text: "x", _token: "tok" });
    expect(ok.status).not.toBe(403);
    expect(ok.status).toBe(404);
  });
});

describe("freshness (Review Focus 3)", () => {
  let fresh: ReturnType<typeof makeUiRoot>;
  let s: UiServer;
  beforeAll(() => {
    fresh = makeUiRoot();
    s = startUiServer({ root: fresh.root, port: 0, token: "tok" });
  });
  afterAll(async () => {
    await s.stop();
  });
  const at = (path: string) => fetch(s.url + path.replace(/^\//, ""));
  const atlasRow = (body: string) => body.slice(body.indexOf(`href="/app/${fresh.atlas}"`)).split("</tr>")[0]!;

  test("a status change through the store shows on the next request", async () => {
    expect(atlasRow(await (await at("/?view=list")).text())).toContain("Applied");
    const app = getApplication(layout(fresh.root).applications, fresh.atlas)!;
    setStatus(app, "offer");
    expect(atlasRow(await (await at("/?view=list")).text())).toContain("Offer");
  });

  test("a new version on disk shows on the next request", async () => {
    const dir = join(layout(fresh.root).applications, fresh.atlas, "resume");
    cpSync(join(dir, "v2"), join(dir, "v3"), { recursive: true });
    const body = await (await at(`/app/${fresh.atlas}`)).text();
    expect(body).toContain("v=3");
  });

  test("a deleted application is 404, not 500", async () => {
    rmSync(join(layout(fresh.root).applications, fresh.hostile), { recursive: true, force: true });
    expect((await at(`/app/${fresh.hostile}`)).status).toBe(404);
  });
});

describe("handler errors", () => {
  test("an unexpected error is a 500 page with the message, the stack goes to stderr only", async () => {
    const r = makeUiRoot();
    const s = startUiServer({ root: r.root, port: 0, token: "tok" });
    const dir = join(layout(r.root).applications, r.atlas, "resume");
    const logged = spyOn(console, "error").mockImplementation(() => {});
    chmodSync(dir, 0o000);
    try {
      const res = await fetch(`${s.url}app/${r.atlas}`);
      expect(res.status).toBe(500);
      expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
      const body = await res.text();
      expect(body).toContain("Something went wrong: EACCES");
      expect(body).not.toContain("at readdirSync");
      expect(String(logged.mock.calls[0]?.[0])).toContain("at ");
    } finally {
      chmodSync(dir, 0o755);
      logged.mockRestore();
      await s.stop();
    }
  });
});

describe("startup (Review Focus 5)", () => {
  test("a busy preferred port falls back; a busy explicit port is a UserError", async () => {
    const root = makeUiRoot().root;
    const occupant = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("busy") });
    const P = occupant.port!;
    try {
      const fallback = startUiServer({ root, preferredPort: P });
      try {
        expect(fallback.port).not.toBe(P);
        expect(fallback.port).toBeGreaterThan(0);
        expect(fallback.token.length).toBeGreaterThan(20);
      } finally {
        await fallback.stop();
      }
      let err: unknown;
      try {
        startUiServer({ root, port: P });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(UserError);
      expect((err as UserError).message).toBe(`Port ${P} is in use`);
      expect((err as UserError).hint).toBe("Pick another with --port, or omit it");
    } finally {
      occupant.stop(true);
    }
  });

  test("a directory without config.toml is not a data root", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-noroot-"));
    expect(() => startUiServer({ root: dir, port: 0 })).toThrow(UserError);
    expect(() => startUiServer({ root: dir, port: 0 })).toThrow("No resumely data root");
  });
});
