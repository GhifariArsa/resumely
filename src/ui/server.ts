import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { addNote, STATUSES, type Application, type Status } from "../application/store";
import { setStatus } from "../application/tracking";
import { revealFile } from "../commands/open";
import { UserError } from "../errors";
import { layout, requireDataRoot } from "../paths";
import { renderApplication } from "../pipeline/rerender";
import { pdfIn } from "../pipeline/version";
import { applicationView, boardRows, getApplication, KINDS, profileView, type Kind } from "./data";
import { appPath, errorPage, type Notice, type PageCtx } from "./html";
import { hostAllowed, newToken, originAllowed, parseFilePath, postAllowed, resolveInside, tokenMatches } from "./security";
import { applicationPage } from "./views/application";
import { boardPage } from "./views/board";
import { profilePage } from "./views/profile";

export const DEFAULT_UI_PORT = 4317;

export type UiServerOptions = {
  root: string;
  /** Exact port; busy → UserError. `0` means any free port. */
  port?: number;
  /** Used when `port` is undefined (default DEFAULT_UI_PORT); busy → falls back to an OS-assigned port. */
  preferredPort?: number;
  token?: string;
  reveal?: (file: string) => Promise<void>;
  render?: (o: Parameters<typeof renderApplication>[0]) => Promise<{ version: number }>;
};

export type UiServer = { url: string; port: number; token: string; stop(): Promise<void> };

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'";

const COMMON_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const ASSETS_DIR = join(import.meta.dir, "assets");
const CSS = "text/css; charset=utf-8";
const ASSETS: Record<string, string> = {
  "base.css": CSS,
  "board.css": CSS,
  "application.css": CSS,
  "profile.css": CSS,
  "application.js": "text/javascript; charset=utf-8",
};

const FILE_TYPES = {
  pdf: "application/pdf",
  tex: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
} as const;

const NO_MATCH = "No application or version matches this link.";
const VERSION_PARAM = /^[1-9]\d*$/;
const NOTE_LIMIT = 2000;

function plain(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...COMMON_HEADERS, "Content-Type": "text/plain; charset=utf-8", ...extra } });
}

function htmlResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { ...COMMON_HEADERS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": CSP },
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { ...COMMON_HEADERS, Location: location } });
}

/** The generic 500 page: the message is shown, the stack goes to stderr only. */
function serverError(ctx: PageCtx, e: unknown): Response {
  const err = e instanceof Error ? e : new Error(String(e));
  console.error(err.stack ?? err.message);
  return htmlResponse(500, errorPage(ctx, 500, `Something went wrong: ${err.message}`));
}

function decodeSegment(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function boardResponse(root: string, q: URLSearchParams, ctx: PageCtx): Response {
  const view = q.get("view") === "list" ? "list" : "board";
  const s = q.get("status");
  const status = s !== null && (STATUSES as readonly string[]).includes(s) ? (s as Status) : undefined;
  const company = q.get("company") || undefined;
  const filter = { status, company };
  const rows = boardRows(root, filter);
  const total = status || company ? boardRows(root).length : rows.length;
  return htmlResponse(200, boardPage(rows, { view, filter, total }, ctx));
}

function applicationResponse(root: string, rawSlug: string, q: URLSearchParams, ctx: PageCtx): Response {
  const notFound = () => htmlResponse(404, errorPage(ctx, 404, NO_MATCH));
  const slug = decodeSegment(rawSlug);
  const kind = q.get("kind");
  const v = q.get("v");
  if (slug === null) return notFound();
  if (kind !== null && !(KINDS as readonly string[]).includes(kind)) return notFound();
  if (v !== null && !VERSION_PARAM.test(v)) return notFound();
  const view = applicationView(root, slug, { kind: (kind ?? undefined) as Kind | undefined, version: v === null ? undefined : Number(v) });
  return view ? htmlResponse(200, applicationPage(view, ctx)) : notFound();
}

function assetResponse(name: string): Response {
  const type = Object.hasOwn(ASSETS, name) ? ASSETS[name] : undefined;
  if (!type) return plain(404, "Not found");
  return new Response(Bun.file(join(ASSETS_DIR, name)), { headers: { ...COMMON_HEADERS, "Content-Type": type } });
}

function fileResponse(root: string, pathname: string): Response {
  const notFound = () => plain(404, "Not found");
  const p = parseFilePath(pathname);
  if (!p) return notFound();
  const appsDir = layout(root).applications;
  if (!getApplication(appsDir, p.slug)) return notFound();
  const real = resolveInside(appsDir, [p.slug, p.kind, `v${p.version}`, p.name]);
  if (!real) return notFound();
  const ext = p.name.slice(p.name.lastIndexOf(".") + 1) as keyof typeof FILE_TYPES;
  return new Response(Bun.file(real), {
    headers: { ...COMMON_HEADERS, "Content-Type": FILE_TYPES[ext], "Content-Disposition": `inline; filename="${p.name}"` },
  });
}

/** Like the CLI, a note keeps its line breaks: spaces collapse within lines, and at most one blank line in a row. */
function normaliseNote(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type Deps = {
  root: string;
  ctx: PageCtx;
  reveal: (file: string) => Promise<void>;
  render: (o: Parameters<typeof renderApplication>[0]) => Promise<{ version: number }>;
};

const ACTION_PATH = /^\/app\/([^/]+)\/(status|note|render|reveal)$/;

/** POST /app/<slug>/<action>. Success is a 303 back to the page; an error re-renders it with a notice. */
async function actionResponse(d: Deps, path: string, form: FormData): Promise<Response> {
  const m = ACTION_PATH.exec(path);
  if (!m) return htmlResponse(404, errorPage(d.ctx, 404, "Nothing here accepts that request."));
  const slug = decodeSegment(m[1]!);
  const app = slug === null ? null : getApplication(layout(d.root).applications, slug);
  if (!app) return htmlResponse(404, errorPage(d.ctx, 404, NO_MATCH));

  const field = (name: string): string | null => {
    const v = form.get(name);
    return typeof v === "string" ? v : null;
  };
  const k = field("kind");
  const kind = k !== null && (KINDS as readonly string[]).includes(k) ? (k as Kind) : undefined;
  const v = field("v");
  const version = v !== null && VERSION_PARAM.test(v) ? Number(v) : undefined;

  const back = (ver = version): Response => {
    const q = new URLSearchParams();
    if (kind) q.set("kind", kind);
    if (ver !== undefined) q.set("v", String(ver));
    const qs = q.toString();
    return redirect(`${appPath(app.slug)}${qs ? `?${qs}` : ""}`);
  };
  const fail = (status: number, notice: Notice): Response => {
    const view = applicationView(d.root, app.slug, { kind, version }) ?? applicationView(d.root, app.slug);
    return view ? htmlResponse(status, applicationPage(view, d.ctx, notice)) : htmlResponse(404, errorPage(d.ctx, 404, NO_MATCH));
  };

  switch (m[2]) {
    case "status":
      return statusAction(app, field("status"), form.get("force") === "1", back, fail);
    case "note": {
      const text = normaliseNote(field("text") ?? "");
      if (!text) return fail(400, { tone: "error", message: "Write a note first" });
      if (text.length > NOTE_LIMIT) return fail(400, { tone: "error", message: `Notes are limited to ${NOTE_LIMIT} characters` });
      addNote(app, text);
      return back();
    }
    case "render": {
      if (!kind || version === undefined) return fail(400, { tone: "error", message: "Pick a document version to re-render" });
      const template = field("template");
      if (!template) return fail(400, { tone: "error", message: "Pick a template" });
      try {
        const r = await d.render({ root: d.root, query: app.slug, template, kind, version, open: false });
        return back(r.version);
      } catch (e) {
        if (e instanceof UserError) return fail(400, { tone: "error", message: e.message, hint: e.hint });
        throw e;
      }
    }
    default: {
      // reveal
      const missing = () => fail(404, { tone: "error", message: NO_MATCH });
      if (!kind || version === undefined) return missing();
      const dir = join(app.dir, kind, `v${version}`);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) return missing();
      let pdf: string;
      try {
        pdf = pdfIn(dir);
      } catch (e) {
        if (e instanceof UserError) return fail(404, { tone: "error", message: e.message });
        throw e;
      }
      await d.reveal(pdf);
      return back();
    }
  }
}

const APPLY_ANYWAY_HINT = "Re-render or fix it, or mark it as applied anyway";

function statusAction(app: Application, status: string | null, force: boolean, back: () => Response, fail: (status: number, n: Notice) => Response): Response {
  if (status === null || !(STATUSES as readonly string[]).includes(status)) return fail(400, { tone: "error", message: "Unknown status" });
  // The select defaults to the current status, so saving it unchanged must not re-pin the sent versions or applied_at.
  if (status === app.meta.status && !force) return back();
  try {
    setStatus(app, status as Status, { force });
  } catch (e) {
    if (e instanceof UserError) {
      const retryApplied = status === "applied";
      return fail(409, { tone: "error", message: e.message, hint: retryApplied ? APPLY_ANYWAY_HINT : e.hint, retryApplied });
    }
    throw e;
  }
  return back();
}

function route(d: Deps, req: Request, url: URL, form: FormData | null): Response | Promise<Response> {
  const { root, ctx } = d;
  const path = url.pathname;
  if (req.method === "POST") return actionResponse(d, path, form!);
  if (path === "/") return boardResponse(root, url.searchParams, ctx);
  if (path === "/profile") return htmlResponse(200, profilePage(profileView(root), ctx));
  const app = /^\/app\/([^/]+)$/.exec(path);
  if (app) return applicationResponse(root, app[1]!, url.searchParams, ctx);
  const asset = /^\/assets\/([^/]+)$/.exec(path);
  if (asset) return assetResponse(asset[1]!);
  if (path.startsWith("/files/")) return fileResponse(root, path);
  return htmlResponse(404, errorPage(ctx, 404, "There is no page at this address."));
}

type Handlers = { fetch: (req: Request, server: Server<undefined>) => Promise<Response>; error: (e: Error) => Response };

function listen(port: number, h: Handlers): Server<undefined> | null {
  try {
    return Bun.serve({ hostname: "127.0.0.1", port, maxRequestBodySize: 65536, development: false, fetch: h.fetch, error: h.error });
  } catch (e) {
    if ((e as { code?: string }).code === "EADDRINUSE") return null;
    throw e;
  }
}

export function startUiServer(o: UiServerOptions): UiServer {
  requireDataRoot(o.root);
  const root = o.root;
  const token = o.token ?? newToken();
  const ctx: PageCtx = { token, root, platform: process.platform };
  const render = o.render ?? renderApplication;
  // One compile at a time: each render waits for the previous one, whether it succeeded or failed.
  let renderQueue: Promise<unknown> = Promise.resolve();
  const deps: Deps = {
    root,
    ctx,
    reveal: o.reveal ?? revealFile,
    render: (opts) => {
      const run = renderQueue.then(() => render(opts));
      renderQueue = run.catch(() => {});
      return run;
    },
  };

  const fetch = async (req: Request, srv: Server<undefined>): Promise<Response> => {
    const port = srv.port!;
    if (!hostAllowed(req.headers.get("host"), port)) return plain(403, "Forbidden: unexpected Host header");
    if (!originAllowed(req.headers.get("origin"), port)) return plain(403, "Forbidden: cross-origin request");
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") return plain(405, "Method not allowed", { Allow: "GET, POST" });
    let form: FormData | null = null;
    if (req.method === "POST") {
      const denied = () => plain(403, "Forbidden: missing or invalid token");
      if (!postAllowed(req, port)) return denied();
      try {
        form = await req.formData();
      } catch {
        return denied();
      }
      if (!tokenMatches(form.get("_token"), token)) return denied();
    }
    try {
      return await route(deps, req, new URL(req.url), form);
    } catch (e) {
      if (e instanceof UserError) return htmlResponse(400, errorPage(ctx, 400, e.message, e.hint));
      return serverError(ctx, e);
    }
  };
  const handlers: Handlers = { fetch, error: (e) => serverError(ctx, e) };

  let server: Server<undefined> | null;
  if (o.port !== undefined) {
    server = listen(o.port, handlers);
    if (!server) throw new UserError(`Port ${o.port} is in use`, "Pick another with --port, or omit it");
  } else {
    server = listen(o.preferredPort ?? DEFAULT_UI_PORT, handlers) ?? listen(0, handlers);
    if (!server) throw new UserError("No free port to listen on", "Pick one with --port");
  }
  const s = server;
  const port = s.port!;
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    token,
    async stop() {
      await s.stop(true);
    },
  };
}
