const SPECIAL: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "&": "\\&",
  "%": "\\%",
  $: "\\$",
  "#": "\\#",
  _: "\\_",
  "{": "\\{",
  "}": "\\}",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

/**
 * Non-ASCII characters rewritten to LaTeX commands. Needs amssymb (\checkmark) in the template
 * preamble; \texteuro is in the LaTeX kernel (eurosym is avoided: it clashes with marvosym's \EUR).
 * The Latin Extended-A letters at the end have no glyph in pdfLaTeX's T1 encoding, so they fall
 * back to the nearest plain letters.
 */
export const SYMBOLS: Record<string, string> = {
  "→": "\\textrightarrow{}",
  "←": "\\textleftarrow{}",
  "≈": "$\\approx$",
  "≥": "$\\geq$",
  "≤": "$\\leq$",
  "×": "$\\times$",
  "✓": "\\checkmark{}",
  "✔": "\\checkmark{}",
  "•": "\\textbullet{}",
  "…": "\\ldots{}",
  "™": "\\texttrademark{}",
  "®": "\\textregistered{}",
  "©": "\\textcopyright{}",
  "€": "\\texteuro{}",
  "\u00a0": "~",
  "′": "$'$",
  Ħ: "H",
  ħ: "h",
  ĸ: "k",
  Ŀ: "L\\textperiodcentered{}",
  ŀ: "l\\textperiodcentered{}",
  ŉ: "'n",
  Ŧ: "T",
  ŧ: "t",
  ſ: "s",
};

const MAP: Record<string, string> = { ...SPECIAL, ...SYMBOLS };
const RE = new RegExp(`[${Object.keys(MAP).map((c) => c.replace(/[\\\]^-]/g, "\\$&")).join("")}]`, "gu");

/** Typographic punctuation pdfLaTeX handles natively under utf8 inputenc + T1. */
const PUNCT = new Set(["–", "—", "‘", "’", "“", "”"]);

/** Single-pass escape so replacement output is never re-escaped. */
export function latexEscape(s: string): string {
  return s.replace(RE, (c) => MAP[c]!);
}

function supported(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  if (cp >= 0x20 && cp <= 0x7e) return true;
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return true;
  if (cp >= 0xa0 && cp <= 0x17f) return true;
  return ch in SYMBOLS || PUNCT.has(ch);
}

/** Distinct characters in `s` that the renderer can't typeset (in order of first appearance). */
export function unsupportedChars(s: string): string[] {
  const out = new Set<string>();
  for (const ch of s) if (!supported(ch)) out.add(ch);
  return [...out];
}

/** Escape a URL for use inside \href{...} (only % and # need it there). */
export function latexUrl(s: string): string {
  return s.replace(/[%#]/g, (c) => "\\" + c);
}

/** Deep-map every string in a JSON-like value through latexEscape. */
export function escapeDeep<T>(v: T): T {
  if (typeof v === "string") return latexEscape(v) as T;
  if (Array.isArray(v)) return v.map(escapeDeep) as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, escapeDeep(x)])) as T;
  }
  return v;
}
