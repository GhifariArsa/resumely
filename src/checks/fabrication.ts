/** Deterministic fabrication scan: numbers and proper nouns in generated text that no cited source supports. */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Capitalised words that are never treated as claims. Compared case-insensitively, without a trailing `.`. */
export const STOP_WORDS: readonly string[] = ["I", "A", "The", "We", ...MONTHS, ...WEEKDAYS, "e.g", "i.e", "vs", "etc"];

/** Generic capitalised words (titles, ubiquitous acronyms) that need no sourcing. An optional plural "s" is accepted. */
export const GENERIC_CAPITALISED: readonly string[] = [
  "Senior", "Engineer", "Team", "API", "REST", "CI", "CD", "SQL", "UI", "UX", "RFC", "B.Sc", "M.Sc", "PhD",
  "JSON", "HTTP", "HTTPS", "SaaS", "SLA", "SLO", "SDK", "B2B", "B2C", "CRM", "ERP", "KPI", "OKR", "ML", "AI", "LLM",
  "ETL", "MVP", "QA", "CLI", "GUI", "OS", "Q1", "Q2", "Q3", "Q4",
];

/** Patterns for generic tokens (latency percentiles). */
export const GENERIC_PATTERNS: readonly RegExp[] = [/^p(50|90|95|99)$/i];

/** Sentence-initial words that are exempt from proper-noun checks (besides -ed/-ing words and stop words). */
export const RESUME_VERBS: readonly string[] = [
  "Led", "Lead", "Built", "Build", "Ran", "Run", "Drove", "Drive", "Grew", "Grow", "Wrote", "Write", "Made", "Make", "Won", "Win",
  "Own", "Owned", "Took", "Take", "Shipped", "Ship", "Cut", "Set", "Spun", "Sped", "Speed", "Spearhead", "Architect", "Automate",
  "Create", "Design", "Develop", "Deliver", "Deploy", "Define", "Establish", "Engineer", "Implement", "Improve", "Increase",
  "Introduce", "Launch", "Maintain", "Manage", "Migrate", "Mentor", "Optimize", "Optimise", "Organize", "Organise", "Overhaul",
  "Partner", "Plan", "Present", "Reduce", "Refactor", "Rebuild", "Replace", "Resolve", "Scale", "Streamline", "Support",
  "Test", "Train", "Transform", "Upgrade", "Coordinate", "Collaborate", "Configure", "Contribute", "Drafted", "Fixed", "Found",
  "Got", "Gave", "Held", "Kept", "Taught", "Began", "Begin", "Chose", "Choose", "Saw", "Sold", "Sell", "Sent", "Send", "Put",
  "Hired", "Hire", "Handle", "Open", "Reworked", "Rewrote", "Rewrite", "Oversaw", "Oversee", "Became", "Become", "Brought",
  "Bring", "Cleared", "Co-led", "Mentoring", "Achieve", "Analyze", "Analyse", "Apply", "Assist", "Audit", "Boost", "Carry",
  "Document", "Enable", "Ensure", "Execute", "Facilitate", "Generate", "Guide", "Identify", "Integrate", "Lower", "Monitor",
  "Prototype", "Review", "Secure", "Simplify", "Standardize", "Standardise", "Unify", "Use", "Utilize", "Validate",
];

const IGNORED = new Set([...STOP_WORDS, ...GENERIC_CAPITALISED].map((w) => w.toLowerCase()));
const VERBS = new Set(RESUME_VERBS.map((w) => w.toLowerCase()));
const STOPS = new Set(STOP_WORDS.map((w) => w.toLowerCase()));

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-token match: no letter/digit/_/#/+/. directly before, and no letter/digit/#/+ (or `.`+alnum) after. */
export function hasToken(text: string, token: string, caseSensitive = false): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}_#+.])${esc(token)}(?![\\p{L}\\p{N}_#+]|\\.[\\p{L}\\p{N}])`, caseSensitive ? "u" : "iu").test(text);
}

const WORD_NUMBERS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
  "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];
const WORD_RE = new RegExp(`\\b(${WORD_NUMBERS.join("|")})\\b`, "gi");

function normaliseNumbers(text: string): string {
  return text
    .replace(/(\d)\s*percent\b/gi, "$1%")
    .replace(/(\d)\s*thousand\b/gi, "$1k")
    .replace(/(\d)\s*million\b/gi, "$1m")
    .replace(/(\d)\s*billion\b/gi, "$1b")
    .replace(WORD_RE, (w) => String(WORD_NUMBERS.indexOf(w.toLowerCase())));
}

const NUMBER_RE = /(?<![\p{L}\d_.,])\$?\d+(?:,\d{3})*(?:\.\d+)?(?:\s?(%|[kmbx](?![\p{L}\p{N}])))?/giu;

function numbersIn(text: string): { raw: string; key: string }[] {
  const out: { raw: string; key: string }[] = [];
  for (const m of normaliseNumbers(text).matchAll(NUMBER_RE)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits) out.push({ raw: m[0].trim(), key: `${digits}|${(m[1] ?? "").toLowerCase()}` });
  }
  return out;
}

const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}+#.]*/gu;

function isProperNoun(t: string): boolean {
  if (/^\d/.test(t) || t.length < 2) return false;
  return /^\p{Lu}/u.test(t) || /[\p{Lu}\p{N}#.+]/u.test(t.slice(1));
}

function isGeneric(t: string): boolean {
  const l = t.toLowerCase();
  return IGNORED.has(l) || (l.endsWith("s") && IGNORED.has(l.slice(0, -1))) || GENERIC_PATTERNS.some((p) => p.test(t));
}

function exemptAtSentenceStart(t: string): boolean {
  const l = t.toLowerCase();
  return /(ed|ing)$/.test(l) || VERBS.has(l) || STOPS.has(l);
}

const SENTENCE_SPLIT = /(?<=[.!?;:])(?<!\be\.g\.|\bi\.e\.|\bvs\.|\betc\.)\s+/i;

/** Returns the numbers and proper nouns in `text` that do not appear in `sources` (numbers first, then nouns). */
export function scanClaims(text: string, sources: string[]): string[] {
  const joined = sources.join("\n");
  const sourced = new Set(numbersIn(joined).map((n) => n.key));
  const numbers: string[] = [];
  const nouns: string[] = [];
  const addTo = (list: string[], t: string) => {
    if (!list.includes(t)) list.push(t);
  };

  for (const n of numbersIn(text)) if (!sourced.has(n.key)) addTo(numbers, n.raw);

  for (const sentence of text.split(SENTENCE_SPLIT)) {
    const tokens = sentence.match(TOKEN_RE) ?? [];
    tokens.forEach((raw, i) => {
      const t = raw.replace(/\.+$/, "");
      if (!isProperNoun(t) || isGeneric(t)) return;
      if (i === 0 && exemptAtSentenceStart(t)) return;
      if (!hasToken(joined, t, t.length <= 3)) addTo(nouns, t);
    });
  }
  return [...numbers.filter((n) => !nouns.some((p) => p.includes(n))), ...nouns];
}
