import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDataRoot } from "../src/commands/init";
import { editorArgv, openInEditor } from "../src/commands/editor";
import { layout } from "../src/paths";
import { inboxDir, listProposals, writeProposal } from "../src/profile/inbox";
import type { DraftEntry } from "../src/profile/proposal";
import { formatInboxList, reviewInbox } from "../src/profile/review";

const fx = join(import.meta.dir, "fixtures");
let root: string;
let pdir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resumely-review-"));
  initDataRoot(root);
  cpSync(join(fx, "profile-jordan"), layout(root).profile, { recursive: true });
  pdir = layout(root).profile;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const draft = (o: Partial<DraftEntry> & { title: string }): DraftEntry => ({ type: "experience", skills: [], tags: [], bullets: [], context: "", ...o });
const src = { kind: "import", ref: "cv.pdf" } as const;
const mk = (kind: "new" | "update" | "duplicate", id: string, e: Partial<DraftEntry> & { title: string }, target?: string, flags: string[] = []) =>
  writeProposal(pdir, { kind, source: src, rationale: "because", flags, ...(target ? { target_id: target } : {}), entry: { ...draft(e), id } });

function stage4() {
  const a = mk("new", "exp-acme", { title: "Engineer", org: "Acme", bullets: ["Did things"] });
  const b = mk("update", "exp-atlas-labs", { title: "Staff Engineer", org: "Atlas Labs", location: "Montreal, QC", start: "2023-03", end: "present", bullets: ["Led"] }, "exp-atlas-labs");
  const c = mk("duplicate", "exp-atlas-labs", { title: "Staff Engineer", org: "Atlas Labs", start: "2023-03", end: "present", bullets: ["Other"] }, "exp-atlas-labs");
  const d = writeProposal(pdir, { kind: "skills", source: src, rationale: "", flags: [], skills: { Languages: ["Rust"] } });
  return [a, b, c, d];
}
const run = async (answers: string[], edit?: (f: string) => Promise<void>) => {
  let out = "";
  const r = await reviewInbox({ profileDir: pdir, io: { input: (async function* () { for (const l of answers) yield l + "\n"; })() }, out: { write: (s) => (out += s) }, edit });
  return { r, out };
};

describe("reviewInbox", () => {
  test("a / r / n / s decisions", async () => {
    const [a, b, c, d] = stage4();
    const skillsBefore = readFileSync(join(pdir, "skills.yaml"), "utf8");
    const { r, out } = await run(["a", "r", "n", "s"]);
    expect(r.accepted).toEqual([a!.pid, c!.pid]);
    expect(r.rejected).toEqual([b!.pid]);
    expect(r.skipped).toEqual([d!.pid]);
    expect(existsSync(join(pdir, "experience/acme.md"))).toBe(true);
    expect(existsSync(join(pdir, "experience/atlas-labs-2.md"))).toBe(true);
    expect(readFileSync(join(pdir, "skills.yaml"), "utf8")).toBe(skillsBefore);
    expect(out).toContain(`accepted ${a!.pid} → profile/experience/acme.md`);
    expect(out).toContain("2 accepted, 1 rejected, 1 skipped, 0 still pending");
  });
  test("unknown answers re-ask", async () => {
    stage4();
    const { out } = await run(["x", "a"]);
    expect(out.split("[a]ccept [e]dit [r]eject [s]kip [q]uit: ").length - 1).toBeGreaterThanOrEqual(2);
  });
  test("EOF leaves the rest pending", async () => {
    stage4();
    const { r, out } = await run(["a"]);
    expect(r.accepted).toHaveLength(1);
    expect(r.skipped).toHaveLength(0);
    expect(out).toContain("3 still pending");
  });
  test("duplicate preview is a diff; flags and rationale shown", async () => {
    mk("duplicate", "exp-atlas-labs", { title: "Staff Engineer", org: "Atlas Labs", start: "2023-03", end: "present" }, "exp-atlas-labs", ['unsourced "Kubernetes"']);
    const { out } = await run(["s"]);
    expect(out).toContain("--- a/profile/experience/atlas-labs.md");
    expect(out).toContain('! unsourced "Kubernetes"');
    expect(out).toContain("because");
    expect(out).toContain("[u]pdate exp-atlas-labs / [n]ew entry / [e]dit / [r]eject / [s]kip / [q]uit: ");
  });
  test("edit then accept writes the edited text", async () => {
    const [, b] = stage4();
    const edit = async (f: string) => {
      const t = readFileSync(f, "utf8");
      await Bun.write(f, t.replace("title: Staff Engineer", "title: Principal Engineer"));
    };
    const { r } = await run(["s", "e", "a"], edit);
    expect(r.accepted).toEqual([b!.pid]);
    expect(readFileSync(join(pdir, "experience/atlas-labs.md"), "utf8")).toContain("Principal Engineer");
    expect(existsSync(join(inboxDir(pdir), `${b!.pid}.edit.md`))).toBe(false);
  });
  test("edit with broken YAML keeps the proposal", async () => {
    const [a] = stage4();
    const { out } = await run(["e", "q"], async (f) => void (await Bun.write(f, "---\nid: [oops\n---\n")));
    expect(out).toContain("error:");
    expect(listProposals(pdir).find((p) => p.pid === a!.pid)!.entry!.title).toBe("Engineer");
    expect(existsSync(join(inboxDir(pdir), `${a!.pid}.edit.md`))).toBe(false);
  });
  test("edit cannot change an update's id", async () => {
    mk("update", "exp-atlas-labs", { title: "Staff Engineer", org: "Atlas Labs" }, "exp-atlas-labs");
    const { out } = await run(["e", "q"], async (f) => void (await Bun.write(f, readFileSync(f, "utf8").replace("id: exp-atlas-labs", "id: exp-other"))));
    expect(out).toContain("id must stay exp-atlas-labs");
  });
  test("edit on a new entry rejects a taken id", async () => {
    mk("new", "exp-acme", { title: "Engineer", org: "Acme" });
    const { out } = await run(["e", "q"], async (f) => void (await Bun.write(f, readFileSync(f, "utf8").replace("id: exp-acme", "id: exp-northwind"))));
    expect(out).toContain("error:");
    expect(out).toContain("taken");
  });
  test("edit a skills proposal", async () => {
    const d = writeProposal(pdir, { kind: "skills", source: src, rationale: "", flags: [], skills: { Languages: ["Rust"] } });
    await run(["e", "q"], async (f) => {
      expect(f.endsWith(".edit.yaml")).toBe(true);
      await Bun.write(f, "skills:\n  Languages: [Rust, Zig]\n");
    });
    expect(listProposals(pdir).find((p) => p.pid === d.pid)!.skills).toEqual({ Languages: ["Rust", "Zig"] });
  });
});

describe("formatInboxList", () => {
  test("empty and rows", () => {
    expect(formatInboxList([])).toBe("Inbox is empty.");
    mk("new", "exp-acme", { title: "Engineer", org: "Acme" });
    const s = formatInboxList(listProposals(pdir));
    expect(s).toContain("PID");
    expect(s).toContain("Engineer @ Acme");
    expect(s).toContain("import:cv.pdf");
  });
});

describe("editor", () => {
  test("editorArgv", () => {
    expect(editorArgv({ EDITOR: "code -w" })).toEqual(["code", "-w"]);
    expect(editorArgv({})).toEqual(["vi"]);
    expect(editorArgv({ VISUAL: "nano", EDITOR: "vi" })).toEqual(["nano"]);
  });
  test("openInEditor runs the editor on the file", async () => {
    const f = join(root, "x.md");
    await Bun.write(f, "hello");
    await openInEditor(f, { EDITOR: `bun ${join(fx, "fake-editor-append.ts")}` });
    expect(readFileSync(f, "utf8")).toContain("<!-- edited -->");
  });
  test("missing editor is a UserError", async () => {
    await expect(openInEditor(join(root, "x.md"), { EDITOR: "no-such-editor-xyz" })).rejects.toThrow('Editor "no-such-editor-xyz" not found');
  });
});

describe("final review fixes", () => {
  test("I2: a ## Private section typed in an edit reaches the live file, never the inbox", async () => {
    const b = mk("update", "exp-atlas-labs", { title: "Staff Engineer", org: "Atlas Labs", start: "2023-03", end: "present", bullets: ["Led"] }, "exp-atlas-labs");
    const n = mk("new", "proj-zed", { type: "project", title: "Zed", bullets: ["Built it"] });
    const inboxText = () => [...readdirSync(inboxDir(pdir)).filter((f) => f.endsWith(".json")).map((f) => join(inboxDir(pdir), f)), ...readdirSync(join(inboxDir(pdir), "archive")).map((f) => join(inboxDir(pdir), "archive", f))].map((f) => readFileSync(f, "utf8")).join("\n");
    const addPrivate = (note: string) => async (f: string) => void (await Bun.write(f, readFileSync(f, "utf8") + `\n## Private\n\n${note}\n`));
    let edits = 0;
    const edit = async (f: string) => (edits++ === 0 ? addPrivate("Raise promised: 999k.")(f) : addPrivate("Side project, not public.")(f));
    const { r, out } = await run(["e", "a", "e", "a"], edit);
    expect(r.accepted).toEqual([b.pid, n.pid]);
    const atlas = readFileSync(join(pdir, "experience/atlas-labs.md"), "utf8");
    expect(atlas).toContain("Raise promised: 999k.");
    expect(atlas).toContain("Compensation: 145000 CAD plus equity.");
    expect(readFileSync(join(pdir, "projects/zed.md"), "utf8")).toContain("Side project, not public.");
    expect(inboxText()).not.toContain("999k");
    expect(inboxText()).not.toContain("Side project");
    expect(out).toContain("+Raise promised: 999k.");
  });

  test("I2: edited private notes are shown again on re-edit, and skipping says they were not saved", async () => {
    mk("new", "proj-zed", { type: "project", title: "Zed", bullets: ["Built it"] });
    let seen = "";
    let edits = 0;
    const edit = async (f: string) => {
      if (edits++ === 0) await Bun.write(f, readFileSync(f, "utf8") + "\n## Private\n\nsecret-x\n");
      else seen = readFileSync(f, "utf8");
    };
    const { out } = await run(["e", "e", "s"], edit);
    expect(seen).toContain("secret-x");
    expect(out).toContain("private notes from your edit were not saved");
  });

  test("I3: a new proposal that duplicates a live entry offers update/new", async () => {
    const a = mk("new", "exp-acme-robotics", { title: "Senior Engineer", org: "Acme Robotics", start: "2024-01", end: "present", bullets: ["A"] });
    const b = mk("new", "exp-acme-robotics-2", { title: "Sr. Engineer", org: "Acme Robotics", start: "2024-01", end: "present", bullets: ["B"] });
    const { r, out } = await run(["a", "a", "u"]);
    expect(r.accepted).toEqual([a.pid, b.pid]);
    expect(out).toContain("[u]pdate exp-acme-robotics / [n]ew entry");
    expect(existsSync(join(pdir, "experience/acme-robotics-2.md"))).toBe(false);
    expect(readFileSync(join(pdir, "experience/acme-robotics.md"), "utf8")).toContain("Sr. Engineer");
  });
});
