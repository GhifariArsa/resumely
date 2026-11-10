export type AtsResult = { status: "ok" | "failed" | "skipped"; problems: string[]; hint?: string };

export type AtsExpect = { name: string; email?: string; phone?: string; headings: string[]; snippets: string[] };

const LIGATURES: Record<string, string> = { "ﬁ": "fi", "ﬂ": "fl", "ﬀ": "ff", "ﬃ": "ffi", "ﬄ": "ffl" };

export function normalizeText(s: string): string {
  return s
    .replace(/[ﬁﬂﬀﬃﬄ]/g, (c) => LIGATURES[c]!)
    .replace(/­/g, "")
    .replace(/(\p{L})-\r?\n(?=\p{L})/gu, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function atsCheck(text: string | null, expect: AtsExpect): AtsResult {
  if (text === null) {
    return { status: "skipped", problems: [], hint: "Install poppler for the ATS check (macOS: brew install poppler)" };
  }
  const problems: string[] = [];
  const norm = normalizeText(text);
  if (!norm.includes(normalizeText(expect.name))) problems.push("name not extractable");
  if (expect.email && !norm.includes(normalizeText(expect.email))) problems.push("email not extractable");
  if (expect.phone) {
    const want = expect.phone.replace(/\D/g, "");
    if (want && !norm.replace(/\D/g, "").includes(want)) problems.push("phone not extractable");
  }
  let pos = 0;
  for (const h of expect.headings) {
    const i = norm.indexOf(normalizeText(h), pos);
    if (i < 0) problems.push(`heading "${h}" missing or out of order`);
    else pos = i + normalizeText(h).length;
  }
  if (text.includes("�")) problems.push("garbled text (U+FFFD)");
  for (const s of expect.snippets) {
    if (!norm.includes(normalizeText(s))) problems.push(`text not continuous: "${s.slice(0, 40)}…"`);
  }
  return { status: problems.length ? "failed" : "ok", problems };
}
