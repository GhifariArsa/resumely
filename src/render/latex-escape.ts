const MAP: Record<string, string> = {
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

/** Single-pass escape so replacement output is never re-escaped. */
export function latexEscape(s: string): string {
  return s.replace(/[\\&%$#_{}~^]/g, (c) => MAP[c]!);
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
