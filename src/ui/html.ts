import type { Status } from "../application/store";

/** Markup the code built itself; inserted by `html` without escaping. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function render(v: unknown): string {
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v === null || v === undefined || v === false) return "";
  return escapeHtml(String(v));
}

/** Tagged template: every interpolated value is escaped unless it is SafeHtml. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? "";
  values.forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? "");
  });
  return new SafeHtml(out);
}

/** Only for markup the code builds itself, never for data. */
export function raw(s: string): SafeHtml {
  return new SafeHtml(s);
}

/** Returns the normalised href for http(s) URLs, else null. */
export function safeHref(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

export type PageCtx = { token: string; root: string; platform: NodeJS.Platform };
export type Notice = { tone: "error" | "info"; message: string; hint?: string; retryApplied?: boolean };

export function page(o: {
  title: string;
  active: "applications" | "profile" | null;
  ctx: PageCtx;
  styles: string[];
  scripts?: string[];
  body: SafeHtml;
}): string {
  const cur = (name: "applications" | "profile") => (o.active === name ? raw(' aria-current="page"') : "");
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${o.title} | resumely</title>
<meta name="resumely-token" content="${o.ctx.token}">
<link rel="stylesheet" href="/assets/base.css">
${o.styles.map((s) => html`<link rel="stylesheet" href="/assets/${s}">\n`)}${(o.scripts ?? []).map((s) => html`<script type="module" src="/assets/${s}"></script>\n`)}</head>
<body>
<header class="shell">
<a class="wordmark" href="/">resumely</a>
<nav aria-label="Primary">
<a href="/"${cur("applications")}>Applications</a>
<a href="/profile"${cur("profile")}>Profile</a>
</nav>
<span class="root path">${o.ctx.root}</span>
</header>
<main>
${o.body}
</main>
</body>
</html>
`.toString();
}

export const STATUS_LABEL: Record<Status, string> = {
  drafted: "Drafted",
  applied: "Applied",
  interviewing: "Interviewing",
  rejected: "Rejected",
  offer: "Offer",
};

export function statusPill(s: Status): SafeHtml {
  return html`<span class="status status-${s}">${STATUS_LABEL[s]}</span>`;
}

export function readyMark(ready: boolean | null): SafeHtml {
  if (ready === null) return html``;
  return ready ? html`<span class="ready">Ready</span>` : html`<span class="not-ready">Not ready</span>`;
}

export function tokenField(token: string): SafeHtml {
  return html`<input type="hidden" name="_token" value="${token}">`;
}

export function noticeBox(n: Notice): SafeHtml {
  const role = n.tone === "error" ? raw(' role="alert"') : raw(' role="status"');
  return html`<div class="notice notice-${n.tone}"${role}><p class="notice-message">${n.message}</p>${n.hint ? html`<p class="notice-hint">${n.hint}</p>` : ""}</div>`;
}

export function emptyState(title: string, hint: SafeHtml | string): SafeHtml {
  return html`<div class="empty"><h2>${title}</h2><p>${hint}</p></div>`;
}

const ERROR_TITLE = { 400: "Can't do that", 404: "Not found", 500: "Something went wrong" } as const;

export function errorPage(ctx: PageCtx, status: 400 | 404 | 500, message: string, hint?: string): string {
  const title = ERROR_TITLE[status];
  return page({
    title,
    active: null,
    ctx,
    styles: [],
    body: html`<section class="error-page"><h1>${title}</h1>${noticeBox({ tone: "error", message, hint })}<p><a href="/">Back to Applications</a></p></section>`,
  });
}
