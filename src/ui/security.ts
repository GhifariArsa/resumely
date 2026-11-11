import { timingSafeEqual } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { KINDS, type Kind } from "./data";

/** A per-launch secret for mutating POSTs: 32 random bytes, base64url. */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

const localOrigins = (port: number) => [`127.0.0.1:${port}`, `localhost:${port}`];

/** DNS-rebinding guard: the Host header must name loopback with this exact port. */
export function hostAllowed(host: string | null, port: number): boolean {
  if (host === null) return false;
  return localOrigins(port).includes(host.toLowerCase());
}

/** Absent Origin is fine (same-origin navigation); the opaque "null" origin and anything foreign are not. */
export function originAllowed(origin: string | null, port: number): boolean {
  if (origin === null) return true;
  return localOrigins(port).some((h) => origin === `http://${h}`);
}

export function postAllowed(req: Request, port: number): boolean {
  return originAllowed(req.headers.get("origin"), port) && req.headers.get("sec-fetch-site") !== "cross-site";
}

/** Constant-time comparison of a form field against the launch token; files and missing fields never match. */
export function tokenMatches(given: FormDataEntryValue | null, token: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const SLUG = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const VERSION = /^v[1-9]\d*$/;
const NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.(pdf|tex|json)$/;

function safeSegment(s: string): boolean {
  return s !== "" && s !== "." && s !== ".." && !/[/\\\0]/.test(s) && !s.startsWith(".");
}

/** Parses `/files/<slug>/<kind>/v<N>/<name>`; anything off that exact shape is null. */
export function parseFilePath(pathname: string): { slug: string; kind: Kind; version: number; name: string } | null {
  if (!pathname.startsWith("/files/")) return null;
  const parts = pathname.slice("/files/".length).split("/");
  if (parts.length !== 4) return null;
  let decoded: string[];
  try {
    decoded = parts.map((p) => decodeURIComponent(p));
  } catch {
    return null;
  }
  if (!decoded.every(safeSegment)) return null;
  const [slug, kind, version, name] = decoded as [string, string, string, string];
  if (!SLUG.test(slug) || !(KINDS as readonly string[]).includes(kind) || !VERSION.test(version) || !NAME.test(name)) return null;
  return { slug, kind: kind as Kind, version: Number(version.slice(1)), name };
}

/** The real path of an existing regular file under `base` (after resolving symlinks), else null. */
export function resolveInside(base: string, segments: string[]): string | null {
  try {
    const realBase = realpathSync(base);
    const real = realpathSync(join(base, ...segments));
    if (real !== realBase && !real.startsWith(realBase + sep)) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}
