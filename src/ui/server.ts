import { join } from "node:path";
import type { Server } from "bun";
import { STATUSES, type Status } from "../application/store";
import { UserError } from "../errors";
import { layout, requireDataRoot } from "../paths";
import type { renderApplication } from "../pipeline/rerender";
import { applicationView, boardRows, getApplication, KINDS, profileView, type Kind } from "./data";
import { errorPage, type PageCtx } from "./html";
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

function plain(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...COMMON_HEADERS, "Content-Type": "text/plain; charset=utf-8", ...extra } });
}

function htmlResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { ...COMMON_HEADERS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": CSP },
  });
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

function route(root: string, req: Request, url: URL, ctx: PageCtx): Response {
  const path = url.pathname;
  if (req.method === "POST") return htmlResponse(404, errorPage(ctx, 404, "Nothing here accepts that request."));
  if (path === "/") return boardResponse(root, url.searchParams, ctx);
  if (path === "/profile") return htmlResponse(200, profilePage(profileView(root), ctx));
  const app = /^\/app\/([^/]+)$/.exec(path);
  if (app) return applicationResponse(root, app[1]!, url.searchParams, ctx);
  const asset = /^\/assets\/([^/]+)$/.exec(path);
  if (asset) return assetResponse(asset[1]!);
  if (path.startsWith("/files/")) return fileResponse(root, path);
  return htmlResponse(404, errorPage(ctx, 404, "There is no page at this address."));
}

function listen(port: number, fetch: (req: Request, server: Server<undefined>) => Promise<Response>): Server<undefined> | null {
  try {
    return Bun.serve({ hostname: "127.0.0.1", port, maxRequestBodySize: 65536, fetch });
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

  const fetch = async (req: Request, srv: Server<undefined>): Promise<Response> => {
    const port = srv.port!;
    if (!hostAllowed(req.headers.get("host"), port)) return plain(403, "Forbidden: unexpected Host header");
    if (!originAllowed(req.headers.get("origin"), port)) return plain(403, "Forbidden: cross-origin request");
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") return plain(405, "Method not allowed", { Allow: "GET, POST" });
    if (req.method === "POST") {
      const denied = () => plain(403, "Forbidden: missing or invalid token");
      if (!postAllowed(req, port)) return denied();
      let form: FormData;
      try {
        form = await req.formData();
      } catch {
        return denied();
      }
      if (!tokenMatches(form.get("_token"), token)) return denied();
    }
    try {
      return route(root, req, new URL(req.url), ctx);
    } catch (e) {
      if (e instanceof UserError) return htmlResponse(400, errorPage(ctx, 400, e.message, e.hint));
      const err = e instanceof Error ? e : new Error(String(e));
      console.error(err.stack ?? err.message);
      return htmlResponse(500, errorPage(ctx, 500, `Something went wrong: ${err.message}`));
    }
  };

  let server: Server<undefined> | null;
  if (o.port !== undefined) {
    server = listen(o.port, fetch);
    if (!server) throw new UserError(`Port ${o.port} is in use`, "Pick another with --port, or omit it");
  } else {
    server = listen(o.preferredPort ?? DEFAULT_UI_PORT, fetch) ?? listen(0, fetch);
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
