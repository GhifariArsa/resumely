import { STATUSES } from "../../application/store";
import type { TraceRow } from "../../application/trace";
import type { AppView, DocView, Kind } from "../data";
import { emptyState, html, noticeBox, page, raw, readyMark, safeHref, STATUS_LABEL, statusPill, tokenField, type Notice, type PageCtx, type SafeHtml } from "../html";

const KIND_LABEL: Record<Kind, string> = { resume: "Resume", "cover-letter": "Cover letter" };
const CURRENT = raw(' aria-current="page"');
const SELECTED = raw(" selected");

/* checks.json, meta.json, parsed.json and trace.json are read without shape validation, so every
   field is checked here: a hand-edited file must render, never throw. */
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function list(items: string[], cls = ""): SafeHtml {
  if (items.length === 0) return html`<p class="meta">None</p>`;
  return html`<ul${cls ? html` class="${cls}"` : ""}>${items.map((i) => html`<li>${i}</li>`)}</ul>`;
}

function hiddenDoc(doc: DocView | null): SafeHtml {
  return doc ? html`<input type="hidden" name="kind" value="${doc.kind}"><input type="hidden" name="v" value="${doc.version}">` : html``;
}

function panel(title: SafeHtml | string, body: SafeHtml, open = false): SafeHtml {
  return html`<details class="panel"${open ? raw(" open") : ""}><summary>${title}</summary>
<div class="panel-body">
${body}
</div>
</details>
`;
}

function sentLine(view: AppView): SafeHtml {
  const sent = view.app.meta.sent;
  if (!sent) return html``;
  const parts: string[] = [];
  if (typeof sent.resume === "number") parts.push(`resume v${sent.resume}`);
  if (typeof sent.cover_letter === "number") parts.push(`cover letter v${sent.cover_letter}`);
  if (parts.length === 0) return html``;
  const at = text(view.app.meta.applied_at);
  return html`<p class="sent-line">Sent ${parts.join(" and ")}${at ? ` on ${at.slice(0, 10)}` : ""}</p>`;
}

function header(view: AppView): SafeHtml {
  const m = view.app.meta;
  const posting = safeHref(m.source?.url);
  return html`<header class="app-head">
<h1>${m.company}</h1>
<div class="app-meta">
<span class="role">${m.role}</span>
${statusPill(m.status)}
<span class="meta num">${String(m.created ?? "").slice(0, 10)}</span>
${posting ? html`<a href="${posting}" target="_blank" rel="noopener noreferrer">Posting</a>` : ""}
</div>
${sentLine(view)}
</header>`;
}

function notices(view: AppView, ctx: PageCtx, notice: Notice | undefined): SafeHtml {
  const doc = view.doc;
  const retry = notice?.retryApplied
    ? html`<form class="retry" method="post" action="/app/${view.app.slug}/status">
${tokenField(ctx.token)}<input type="hidden" name="status" value="applied"><input type="hidden" name="force" value="1">${hiddenDoc(doc)}
<button type="submit">Mark as applied anyway</button>
</form>`
    : "";
  const problems = [...view.problems, ...(doc?.problems ?? [])];
  return html`${notice ? noticeBox(notice) : ""}${retry}${problems.map((p) => noticeBox({ tone: "info", message: p }))}`;
}

function docPane(view: AppView, doc: DocView): SafeHtml {
  const tabs = html`<nav class="kind-tabs" aria-label="Document">${view.kinds.map(
    (k) => html`<a href="?kind=${k}"${k === doc.kind ? CURRENT : ""}>${KIND_LABEL[k]}</a>`,
  )}</nav>`;
  const versions = html`<nav class="version-strip" aria-label="Versions"><ul>${doc.versions.map(
    (v) => html`<li><a href="?kind=${doc.kind}&amp;v=${v.version}"${v.version === doc.version ? CURRENT : ""}><span class="version">v${v.version}</span>${readyMark(v.ready)}${v.sent ? html`<span class="tag-sent">Sent</span>` : ""}</a></li>`,
  )}</ul></nav>`;
  const label = `${KIND_LABEL[doc.kind]} v${doc.version}`;
  const pdf = doc.pdf
    ? html`<iframe class="pdf" src="${doc.pdf.href}" title="${label} PDF"></iframe>
<p class="pdf-link"><a href="${doc.pdf.href}">Open the PDF</a></p>`
    : html`<p class="no-pdf">This version has no PDF</p>`;
  return html`<section class="doc-pane" aria-label="${label}">
${tabs}
${versions}
<div class="pdf-frame">
${pdf}
</div>
</section>`;
}

function traceRow(r: TraceRow): SafeHtml {
  const ids = strings(r.entry_ids);
  return html`<li class="trace-row" data-entries="${ids.join(" ")}">
<span class="trace-section meta">${String(r.section ?? "")}</span>
<p class="doc-text">${String(r.text ?? "")}</p>
<span class="trace-tags">${r.basis === "inferred" ? html`<span class="tag-inferred">Inferred</span>` : ""}${strings(r.flags).map((f) => html`<span class="flag">${f}</span>`)}${ids.map((id) => html`<a class="entry-chip" href="#entry-${id}">${id}</a>`)}</span>
</li>
`;
}

function tracePanel(doc: DocView): SafeHtml {
  const t = doc.trace;
  if (!t) return panel("Trace", html`<p class="meta">No trace for this version</p>`, true);
  const rows = Array.isArray(t.rows) ? t.rows.filter(isObject) as TraceRow[] : [];
  const warnings = strings(t.warnings);
  const sources = doc.entries.map((e) => {
    const dates = [e.start, e.end].filter(Boolean).join(" – ");
    const summary = [e.title, e.org, dates].filter(Boolean).join(", ") || e.id;
    return html`<details class="entry" id="entry-${e.id}"><summary>${summary}</summary>${e.body ? html`<div class="doc-text">${e.body}</div>` : ""}</details>
`;
  });
  return panel(
    html`Trace <span class="count">(${rows.length})</span>`,
    html`<ol class="trace">
${rows.map(traceRow)}</ol>
${warnings.length ? html`<h3>Warnings</h3>${list(warnings, "warnings")}` : ""}
<h3>Sources</h3>
${sources.length ? html`<div class="sources">${sources}</div>` : html`<p class="meta">No source entries recorded</p>`}`,
    true,
  );
}

function gapsPanel(doc: DocView): SafeHtml {
  const kw = isObject(doc.checks) ? doc.checks.keywords : undefined;
  const keywords = isObject(kw)
    ? html`<h3>Covered</h3>${list(strings(kw.present))}
<h3>In your profile but not used</h3>${list(strings(kw.missed_in_profile))}
<h3>Not in your profile</h3>${list(strings(kw.absent))}`
    : html`<p class="meta">No keyword check recorded</p>`;
  const gaps = doc.trace ? strings(doc.trace.gaps) : [];
  return panel(
    "Gaps and keywords",
    html`<h3>Requirements your profile doesn't support</h3>${list(gaps)}
${keywords}`,
  );
}

const SCORES = ["relevance", "keywords", "impact", "formatting", "voice"] as const;
const SCORE_LABEL: Record<(typeof SCORES)[number], string> = { relevance: "Relevance", keywords: "Keywords", impact: "Impact", formatting: "Formatting", voice: "Voice" };

function reviewPanel(doc: DocView): SafeHtml {
  const r = doc.review;
  const from = num(doc.meta.rendered_from);
  const carried = from !== null ? html`<p class="meta">Carried over from v${from} (re-rendered)</p>` : "";
  if (!r) return panel("Review", html`<p class="meta">No review for this version</p>${carried}`, true);
  const scores = SCORES.flatMap((k) => {
    const n = r.scores[k];
    return typeof n === "number"
      ? [html`<li class="score"><span class="score-label">${SCORE_LABEL[k]}</span><meter min="1" max="5" value="${n}" aria-label="${SCORE_LABEL[k]}">${n}/5</meter><span class="num">${n}/5</span></li>`]
      : [];
  });
  return panel(
    "Review",
    html`<p class="verdict verdict-${r.verdict}">${r.verdict === "pass" ? "Pass" : "Revise"}</p>
<p class="doc-text">${r.impression}</p>
<ul class="scores">${scores}</ul>
<h3>Red flags</h3>${list(r.red_flags)}
<h3>Requests</h3>${list(r.requests)}
${doc.meta.reviewed_final === false ? html`<p class="meta">The last revision was not re-reviewed</p>` : ""}${carried}`,
    true,
  );
}

const ATS_LABEL: Record<string, string> = { ok: "Passed", failed: "Failed", skipped: "Skipped" };

function checksPanel(doc: DocView): SafeHtml {
  const c: unknown = doc.checks;
  if (!isObject(c)) return panel("Checks", html`<p class="meta">No checks recorded</p>`, true);
  const ready = typeof doc.meta.ready === "boolean" ? doc.meta.ready : null;
  const ats = isObject(c.ats) ? c.ats : null;
  const atsStatus = ats && typeof ats.status === "string" ? ats.status : null;
  const atsProblems = ats ? strings(ats.problems) : [];
  const atsHint = ats ? text(ats.hint) : null;
  const pages = num(c.pages);
  const target = num(c.target_pages);
  const fill = num(c.fill);
  const words = num(c.word_count);
  const unsourced = strings(c.fabrication_warnings);
  const warnings = strings(c.warnings);
  return panel(
    "Checks",
    html`<p class="checks-summary">${readyMark(ready)}</p>
<p>ATS: <span class="${atsStatus === "failed" ? "not-ready" : ""}">${(atsStatus && ATS_LABEL[atsStatus]) ?? "Unknown"}</span></p>
${atsProblems.length ? list(atsProblems) : ""}${atsHint ? html`<p class="meta">${atsHint}</p>` : ""}
<ul class="facts">
${pages !== null ? html`<li class="num">Pages: ${pages}${target !== null ? ` of ${target}` : ""}</li>` : ""}
<li class="num">Fill: ${fill !== null ? `${Math.round(fill * 100)}%` : "unknown"}</li>
${c.overflow === true ? html`<li class="not-ready">Overflow</li>` : ""}${c.underflow === true ? html`<li class="not-ready">Underflow</li>` : ""}
${words !== null ? html`<li class="num">Words: ${words}</li>` : ""}
</ul>
${unsourced.length ? html`<h3>Unsourced claims</h3>${list(unsourced)}` : ""}
${warnings.length ? html`<h3>Warnings</h3>${list(warnings, "warnings")}` : ""}`,
    true,
  );
}

function templatePanel(view: AppView, doc: DocView, ctx: PageCtx): SafeHtml {
  const current = text(doc.meta.template);
  const form = view.templates.length
    ? html`<form method="post" action="/app/${view.app.slug}/render" data-busy-label="Rendering…">
${tokenField(ctx.token)}${hiddenDoc(doc)}
<label for="template-select">Template</label>
<select id="template-select" name="template">${view.templates.map(
        (t) => html`<option value="${t.id}"${t.id === current ? SELECTED : ""}>${t.name} — ${t.description}</option>`,
      )}</select>
<button type="submit" class="primary">Re-render</button>
<p class="meta">Creates a new version from this one's content. No agent call.</p>
</form>`
    : html`<p class="meta">No templates support this document</p>`;
  return panel("Template", form);
}

function statusPanel(view: AppView, ctx: PageCtx, open: boolean): SafeHtml {
  const { slug, meta } = view.app;
  const notes = strings(meta.notes);
  return panel(
    "Status and notes",
    html`<form method="post" action="/app/${slug}/status" class="stack">
${tokenField(ctx.token)}${hiddenDoc(view.doc)}
<label for="status-select">Status</label>
<select id="status-select" name="status" aria-describedby="status-help">${STATUSES.map((s) => html`<option value="${s}"${s === meta.status ? SELECTED : ""}>${STATUS_LABEL[s]}</option>`)}</select>
<p class="meta" id="status-help">Marking as applied records the latest versions as sent.</p>
<button type="submit">Save status</button>
</form>
<h3>Notes</h3>
${notes.length ? html`<ul class="notes">${notes.map((n) => html`<li>${n}</li>`)}</ul>` : html`<p class="meta">No notes yet</p>`}
<form method="post" action="/app/${slug}/note" class="stack">
${tokenField(ctx.token)}${hiddenDoc(view.doc)}
<label for="note-text">New note</label>
<textarea id="note-text" name="text" rows="3" maxlength="2000" required></textarea>
<button type="submit">Add note</button>
</form>`,
    open,
  );
}

function filesPanel(view: AppView, doc: DocView, ctx: PageCtx): SafeHtml {
  return panel(
    "Files",
    html`<div class="version-dir"><span class="path">${doc.dir}</span> <button type="button" data-copy="${doc.dir}" hidden>Copy path</button></div>
<form method="post" action="/app/${view.app.slug}/reveal">
${tokenField(ctx.token)}${hiddenDoc(doc)}
<button type="submit">${ctx.platform === "darwin" ? "Show in Finder" : "Open folder"}</button>
</form>
<ul class="files">${doc.files.map(
      (f) => html`<li>${f.href ? html`<a class="path" href="${f.href}">${f.name}</a>` : html`<span class="path">${f.name}</span>`} <button type="button" data-copy="${f.path}" hidden>Copy path</button></li>`,
    )}</ul>`,
  );
}

function jobPanel(view: AppView): SafeHtml {
  const p: unknown = view.job.parsed;
  const parsed = isObject(p)
    ? html`<dl class="job">
<dt>Role</dt><dd>${text(p.role) ?? "-"}</dd>
${text(p.location) ? html`<dt>Location</dt><dd>${text(p.location)}</dd>` : ""}
</dl>
<h3>Requirements</h3>${list(strings(p.requirements))}
<h3>Nice to have</h3>${list(strings(p.nice_to_haves))}
<h3>Keywords</h3>${list(strings(p.keywords))}`
    : "";
  const rawText = view.job.raw ? html`<h3>Posting text</h3><pre class="doc-text">${view.job.raw}</pre>` : "";
  return panel("Job posting", parsed || rawText ? html`${parsed}${rawText}` : html`<p class="meta">No job posting saved</p>`);
}

export function applicationPage(view: AppView, ctx: PageCtx, notice?: Notice): string {
  const doc = view.doc;
  const top = html`${header(view)}
${notices(view, ctx, notice)}`;
  const body = doc
    ? html`${top}
<div class="app-grid">
${docPane(view, doc)}
<aside class="inspector" aria-label="Inspector">
${tracePanel(doc)}${gapsPanel(doc)}${reviewPanel(doc)}${checksPanel(doc)}${templatePanel(view, doc, ctx)}${statusPanel(view, ctx, false)}${filesPanel(view, doc, ctx)}${jobPanel(view)}</aside>
</div>`
    : html`${top}
${emptyState("No documents yet", html`Generate them with <code>resumely apply --into ${view.app.slug} &lt;posting&gt;</code>`)}
<div class="inspector inspector-solo">
${statusPanel(view, ctx, true)}</div>`;
  return page({ title: view.app.meta.company, active: "applications", ctx, styles: ["application.css"], scripts: ["application.js"], body });
}
