import { STATUSES, type Status } from "../../application/store";
import type { BoardRow, VersionSummary } from "../data";
import { emptyState, html, page, raw, STATUS_LABEL, statusPill, readyMark, type PageCtx, type SafeHtml } from "../html";

type Opts = { view: "board" | "list"; filter: { status?: string; company?: string }; total: number };

function query(view: Opts["view"], filter: Opts["filter"]): string {
  const p = new URLSearchParams();
  if (view === "list") p.set("view", "list");
  if (filter.status) p.set("status", filter.status);
  if (filter.company) p.set("company", filter.company);
  const q = p.toString();
  return q ? `/?${q}` : "/";
}

function toolbar(o: Opts): SafeHtml {
  const { view, filter } = o;
  const filtered = Boolean(filter.status || filter.company);
  return html`<form class="toolbar" method="get" action="/">
<input type="hidden" name="view" value="${view}">
<label>Company <input name="company" type="search" value="${filter.company ?? ""}"></label>
<label>Status <select name="status"><option value="">Any status</option>${STATUSES.map((s) => html`<option value="${s}"${filter.status === s ? raw(" selected") : ""}>${STATUS_LABEL[s]}</option>`)}</select></label>
<button type="submit">Filter</button>
${filtered ? html`<a href="${query(view, {})}">Clear filters</a>` : ""}
<nav class="view-switch" aria-label="View">
<a href="${query("board", filter)}"${view === "board" ? raw(' aria-current="page"') : ""}>Board</a>
<a href="${query("list", filter)}"${view === "list" ? raw(' aria-current="page"') : ""}>List</a>
</nav>
</form>`;
}

const docLabel = (name: string, v: VersionSummary): SafeHtml =>
  html`<span class="doc"><span class="version">${name} v${v.version}</span>${v.ready === false ? html` ${readyMark(false)}` : ""}</span>`;

function boardRow(r: BoardRow): SafeHtml {
  return html`<a class="app-row" href="/app/${r.slug}">
<strong class="company">${r.company}</strong>
<span class="role">${r.role}</span>
<span class="docs">${r.resume ? docLabel("Resume", r.resume) : ""}${r.cover ? docLabel("Cover letter", r.cover) : ""}${!r.resume && !r.cover ? html`<span class="meta">No documents</span>` : ""}${r.sent ? html`<span class="tag-sent">Sent</span>` : ""}</span>
</a>`;
}

function boardColumns(rows: BoardRow[], filter: Opts["filter"]): SafeHtml {
  const shown: readonly Status[] = filter.status ? STATUSES.filter((s) => s === filter.status) : STATUSES;
  return html`<div class="board-grid">${shown.map((s) => {
    const inCol = rows.filter((r) => r.status === s);
    return html`<section class="column status-${s}">
<h2>${STATUS_LABEL[s]} <span class="count">${inCol.length}</span></h2>
${inCol.map(boardRow)}
</section>
`;
  })}</div>`;
}

function sentText(r: BoardRow): string {
  const parts: string[] = [];
  if (r.sent?.resume !== undefined) parts.push(`Resume v${r.sent.resume}`);
  if (r.sent?.cover_letter !== undefined) parts.push(`${parts.length ? "cover letter" : "Cover letter"} v${r.sent.cover_letter}`);
  return parts.length ? parts.join(", ") : "-";
}

function listTable(rows: BoardRow[]): SafeHtml {
  const v = (s: VersionSummary | null) => (s ? html`<span class="version">v${s.version}</span>${s.ready === false ? html` ${readyMark(false)}` : ""}` : "-");
  return html`<div class="table-scroll" tabindex="0" role="region" aria-label="Applications table"><table class="app-table">
<thead><tr><th scope="col">Date</th><th scope="col">Company</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Resume</th><th scope="col">Cover letter</th><th scope="col">Sent</th></tr></thead>
<tbody>
${rows.map((r) => html`<tr><td class="num">${r.created.slice(0, 10)}</td><td><a href="/app/${r.slug}">${r.company}</a></td><td>${r.role}</td><td>${statusPill(r.status)}</td><td>${v(r.resume)}</td><td>${v(r.cover)}</td><td>${sentText(r)}</td></tr>
`)}</tbody>
</table></div>`;
}

export function boardPage(rows: BoardRow[], o: Opts, ctx: PageCtx): string {
  let content: SafeHtml;
  if (o.total === 0) content = emptyState("No applications yet", html`Start one with <code>resumely apply --clip</code>`);
  else if (rows.length === 0) content = emptyState("No applications match these filters", html`<a href="${query(o.view, {})}">Clear filters</a>`);
  else content = o.view === "list" ? listTable(rows) : boardColumns(rows, o.filter);
  return page({
    title: "Applications",
    active: "applications",
    ctx,
    styles: ["board.css"],
    body: html`<h1>Applications</h1>
${o.total === 0 ? "" : toolbar(o)}
${content}`,
  });
}
