/** Deterministic fabrication scan: numbers and proper nouns in generated text that no cited source supports. */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Capitalised words that are never treated as claims. Compared case-insensitively, without a trailing `.`. */
export const STOP_WORDS: readonly string[] = ["I", "A", "The", "We", ...MONTHS, ...WEEKDAYS, "e.g", "i.e"];

/** Generic capitalised words (titles, ubiquitous acronyms) that need no sourcing. */
export const GENERIC_CAPITALISED: readonly string[] = [
  "Senior", "Engineer", "Team", "API", "REST", "CI", "CD", "SQL", "UI", "UX", "RFC", "B.Sc", "M.Sc", "PhD",
];

const IGNORED = new Set([...STOP_WORDS, ...GENERIC_CAPITALISED].map((w) => w.toLowerCase()));

const NUMBER_RE = /\$?\d[\d,.]*\s?(%|k|m|b|x|\+)?/gi;
const digitsOnly = (s: string) => s.replace(/\D/g, "");

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Case-insensitive whole-token match: no letter/digit/_/#/+ directly on either side. */
export function hasToken(text: string, token: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}_#+])${esc(token)}(?![\\p{L}\\p{N}_#+])`, "iu").test(text);
}

function numbersIn(text: string): { raw: string; digits: string }[] {
  const out: { raw: string; digits: string }[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const digits = digitsOnly(m[0]);
    if (digits) out.push({ raw: m[0].trim().replace(/[,.]+$/, ""), digits });
  }
  return out;
}

const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}+#.]*/gu;

function isProperNoun(t: string): boolean {
  if (/^\d/.test(t) || t.length < 2) return false;
  return /^\p{Lu}/u.test(t) || /[\p{Lu}\p{N}#.+]/u.test(t.slice(1));
}

/** Returns the numbers and proper nouns in `text` that do not appear in `sources` (numbers first, then nouns). */
export function scanClaims(text: string, sources: string[]): string[] {
  const joined = sources.join("\n");
  const sourced = new Set(numbersIn(joined).map((n) => n.digits));
  const found: string[] = [];
  const add = (t: string) => {
    if (!found.includes(t)) found.push(t);
  };

  for (const n of numbersIn(text)) if (!sourced.has(n.digits)) add(n.raw);

  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const tokens = sentence.match(TOKEN_RE) ?? [];
    tokens.forEach((raw, i) => {
      if (i === 0) return;
      const t = raw.replace(/\.+$/, "");
      if (!isProperNoun(t) || IGNORED.has(t.toLowerCase())) return;
      if (!hasToken(joined, t)) add(t);
    });
  }
  return found;
}
