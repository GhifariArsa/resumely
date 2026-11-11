import type { LintIssue } from "../../profile/lint";
import { ENTRY_TYPES, type Entry, type EntryType } from "../../profile/schema";
import type { EntryUsage, ProfileView } from "../data";
import { html, noticeBox, page, type PageCtx, type SafeHtml } from "../html";

const TYPE_HEADING: Record<EntryType, string> = {
  experience: "Experience",
  project: "Projects",
  education: "Education",
  award: "Awards",
  publication: "Publications",
  volunteering: "Volunteering",
  certification: "Certifications",
  other: "Other",
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function issueRow(i: LintIssue, withFile: boolean): SafeHtml {
  const label = i.severity === "error" ? "Error" : "Warning";
  return html`<li class="issue issue-${i.severity}"><span class="severity">${label}</span> <code>${i.code}</code> <span class="issue-message">${i.message}</span>${withFile ? html` <span class="path">${i.file}</span>` : ""}</li>`;
}

function checksSection(view: ProfileView, loadedIds: Set<string>): SafeHtml {
  let content: SafeHtml;
  if (view.lintError !== null) {
    content = noticeBox({ tone: "error", message: view.lintError });
  } else {
    const errors = view.lint.filter((i) => i.severity === "error").length;
    const warnings = view.lint.length - errors;
    const summary = view.lint.length === 0 ? "No problems found" : `${plural(errors, "error")}, ${plural(warnings, "warning")}`;
    const loose = view.lint.filter((i) => i.entry_id === null || !loadedIds.has(i.entry_id));
    content = html`<p class="lint-summary">${summary}</p>${loose.length ? html`<ul class="issues">${loose.map((i) => issueRow(i, true))}</ul>` : ""}`;
  }
  return html`<section id="checks"><h2>Profile checks</h2>${content}</section>`;
}

function usageItem(u: EntryUsage): SafeHtml {
  const last = u.versions[u.versions.length - 1];
  const name = u.kind === "resume" ? "resume" : "cover letter";
  return html`<li><a href="/app/${u.slug}?kind=${u.kind}&amp;v=${last}">${u.company}, ${u.role}</a> <span class="meta">${name} ${u.versions.map((v) => `v${v}`).join(", ")}</span></li>`;
}

function entryBlock(e: Entry, usage: EntryUsage[], issues: LintIssue[]): SafeHtml {
  const dates = [e.start, e.end].filter(Boolean).join(" to ");
  return html`<details class="entry" id="entry-${e.id}">
<summary><span class="entry-title">${e.title}</span>${e.org ? html` <span class="entry-org">${e.org}</span>` : ""}${dates ? html` <span class="entry-dates">${dates}</span>` : ""}</summary>
<div class="entry-meta"><code>${e.id}</code> <span class="path">${e.file}</span></div>
${e.skills.length ? html`<p class="entry-skills"><span class="meta">Skills</span> ${e.skills.join(", ")}</p>` : ""}
${e.tags.length ? html`<p class="entry-tags"><span class="meta">Tags</span> ${e.tags.join(", ")}</p>` : ""}
${issues.length ? html`<ul class="issues">${issues.map((i) => issueRow(i, false))}</ul>` : ""}
${e.privateLines > 0 ? html`<p class="meta">[private: ${e.privateLines} lines withheld]</p>` : ""}
<h4>Used in</h4>
${usage.length ? html`<ul class="usage">${usage.map(usageItem)}</ul>` : html`<p class="meta">Not used yet</p>`}
<div class="doc-text">${e.body}</div>
</details>
`;
}

function entriesSection(view: ProfileView): SafeHtml {
  if (view.loadError !== null) {
    return html`<section id="entries"><h2>Entries</h2>${noticeBox({ tone: "error", message: view.loadError, hint: "Fix the file, then reload. Check with: resumely profile show" })}</section>`;
  }
  const entries = view.profile?.entries ?? [];
  const groups = ENTRY_TYPES.map((t) => ({ t, list: entries.filter((e) => e.type === t) })).filter((g) => g.list.length > 0);
  return html`<section id="entries"><h2>Entries</h2>
${groups.map((g) => html`<h3>${TYPE_HEADING[g.t]}</h3>
${g.list.map((e) => entryBlock(e, view.usage.get(e.id) ?? [], view.lint.filter((i) => i.entry_id === e.id)))}`)}
</section>`;
}

function header(view: ProfileView): SafeHtml {
  const p = view.profile;
  if (!p) return html`<h1>Profile</h1>`;
  const lines = p.entries.reduce((n, e) => n + e.privateLines, 0);
  const notes = [
    lines > 0 ? `${lines} private lines withheld from the agent` : "",
    p.aboutPrivateKeys > 0 ? `${p.aboutPrivateKeys} private fields in about.md` : "",
  ].filter(Boolean);
  return html`<h1>${p.about.name}</h1>${p.about.headline ? html`<p class="headline">${p.about.headline}</p>` : ""}${notes.map((n) => html`<p class="meta private-note">${n}</p>`)}`;
}

export function profilePage(view: ProfileView, ctx: PageCtx): string {
  const loadedIds = new Set((view.profile?.entries ?? []).map((e) => e.id));
  return page({
    title: "Profile",
    active: "profile",
    ctx,
    styles: ["profile.css"],
    body: html`<div class="profile">
${header(view)}
<nav class="in-page" aria-label="On this page"><a href="#checks">Checks</a> <a href="#entries">Entries</a> <a href="#context">Agent context</a></nav>
${checksSection(view, loadedIds)}
${entriesSection(view)}
<section id="context"><h2>What the agent sees</h2>
<p>This is the exact profile payload sent to the agent. Private sections are already removed.</p>
${view.context !== null ? html`<details><summary>Show payload</summary><pre class="context">${view.context}</pre></details>` : ""}
</section>
</div>`,
  });
}
