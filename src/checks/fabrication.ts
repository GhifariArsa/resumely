/** Deterministic fabrication scan: numbers and proper nouns in generated text that no cited source supports. */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Capitalised words that are never treated as claims. Compared case-insensitively, without a trailing `.`. */
export const STOP_WORDS: readonly string[] = ["I", "A", "The", "We", "Then", "Also", "Now", "Later", ...MONTHS, ...WEEKDAYS, "e.g", "i.e", "vs", "etc"];

/** Generic capitalised words (titles, ubiquitous acronyms) that need no sourcing. An optional plural "s" is accepted. */
export const GENERIC_CAPITALISED: readonly string[] = [
  "Senior", "Engineer", "Team", "API", "REST", "CI", "CD", "SQL", "UI", "UX", "RFC", "B.Sc", "M.Sc", "PhD",
  "JSON", "HTTP", "HTTPS", "SaaS", "SLA", "SLO", "SDK", "B2B", "B2C", "CRM", "ERP", "KPI", "OKR", "ML", "AI", "LLM",
  "ETL", "MVP", "QA", "CLI", "GUI", "OS", "Q1", "Q2", "Q3", "Q4",
  "Skills", "Experience", "Projects", "Summary", "Education", "Backend", "Frontend", "Platform", "Engineering",
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
  "Rebuilt", "Stood", "Hit", "Spent", "Split", "Bought", "Sought", "Felt", "Met", "Paid", "Read", "Shot", "Spoke", "Told",
  "Understood", "End-to-end", "Co-led", "Prototype", "Review", "Secure", "Simplify", "Standardize", "Standardise", "Unify", "Use", "Utilize", "Validate",
];

/** Ordinary prose sentence openers. Opt-in (cover letters): resume bullets open with verbs and never need them. */
export const PROSE_OPENERS: readonly string[] = [
  "At", "In", "On", "To", "Of", "By", "For", "From", "With", "Over", "Beyond", "As", "If", "So", "But", "And", "Or", "Yet", "Still", "Just", "Not",
  "My", "Our", "Your", "Their", "Its", "It", "That", "This", "These", "Those", "There", "They", "He", "She", "You",
  "Each", "Both", "Every", "Any", "All", "Most", "Many", "Some", "Another", "Other", "What", "Which", "Why", "How", "Whether", "When", "While", "Once",
  "Since", "Because", "Before", "After", "During", "Earlier", "Later", "Today", "Recently", "Previously", "Currently", "Meanwhile",
  "Finally", "Overall", "Specifically", "Additionally", "However", "Moreover", "Instead", "Rather", "Please", "Thank", "Thanks", "Happy", "Glad",
];

const IGNORED = new Set([...STOP_WORDS, ...GENERIC_CAPITALISED].map((w) => w.toLowerCase()));
const VERBS = new Set(RESUME_VERBS.map((w) => w.toLowerCase()));
const STOPS = new Set(STOP_WORDS.map((w) => w.toLowerCase()));

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-token match: no letter/digit/_/#/+/. directly before, and no letter/digit/#/+ (or `.`+alnum) after. */
export function hasToken(text: string, token: string, caseSensitive = false): boolean {
  const before = token.startsWith(".") ? "(?<![\\p{L}\\p{N}_#+])" : "(?<![\\p{L}\\p{N}_#+.])";
  return new RegExp(`${before}${esc(token)}(?![\\p{L}\\p{N}_#+]|\\.[\\p{L}\\p{N}])`, caseSensitive ? "u" : "iu").test(text);
}

const WORD_NUMBERS = [
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
  "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];
const WORD_RE = new RegExp(`\\b(${WORD_NUMBERS.join("|")})\\b`, "gi");

/** `x2`, `x10` multipliers; architecture names (x86, x64, x32) are not multipliers. */
const MULTIPLIER_RE = /(?<![\p{L}\d_])x(?!(?:86|64|32)\b)(\d{1,2})\b/giu;

/** Unit words and multipliers normalise on both sides; number words (one..twenty) only in sources. */
function normaliseNumbers(text: string, words: boolean): string {
  const t = text
    .replace(/×/g, "x")
    .replace(MULTIPLIER_RE, "$1x")
    .replace(/(?<![\p{L}\d_.])\.(\d)/g, "0.$1")
    .replace(/(\d)\s*percent\b/gi, "$1%")
    .replace(/(\d)\s*thousand\b/gi, "$1k")
    .replace(/(\d)\s*million\b/gi, "$1m")
    .replace(/(\d)\s*billion\b/gi, "$1b");
  return words ? t.replace(WORD_RE, (w) => String(WORD_NUMBERS.indexOf(w.toLowerCase()) + 1)) : t;
}

const NUMBER_RE = /(?<![\p{L}\d_.,])\$?\d+(?:,\d{3})*(?:\.\d+)?(?:\s?(%|[kmbx](?![\p{L}\p{N}])))?/giu;

function numbersIn(text: string, words: boolean): { raw: string; key: string }[] {
  const out: { raw: string; key: string }[] = [];
  for (const m of normaliseNumbers(text, words).matchAll(NUMBER_RE)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits) out.push({ raw: m[0].trim(), key: `${digits}|${(m[1] ?? "").toLowerCase()}` });
  }
  return out;
}

const TOKEN_RE = /(?:(?<![\p{L}\p{N}.])\.)?[\p{L}\p{N}][\p{L}\p{N}+#.]*/gu;

function isProperNoun(t: string): boolean {
  if (/^\d/.test(t) || /^\.\d/.test(t) || /^x(?!(?:86|64|32)$)\d{1,2}$/i.test(t) || t.length < 2) return false;
  return /^\p{Lu}/u.test(t) || /[\p{Lu}\p{N}#.+]/u.test(t.slice(1));
}

function isGeneric(t: string): boolean {
  const l = t.toLowerCase();
  return IGNORED.has(l) || (l.endsWith("s") && IGNORED.has(l.slice(0, -1))) || GENERIC_PATTERNS.some((p) => p.test(t));
}

function exemptWord(l: string): boolean {
  return (
    /(ed|ing)$/.test(l) || VERBS.has(l) || STOPS.has(l) ||
    (l.endsWith("s") && (VERBS.has(l.slice(0, -1)) || VERBS.has(l.slice(0, -2))))
  );
}

const WORD_PREFIXES = new Set([
  "co", "re", "pre", "self", "cross", "multi", "over", "under", "out", "de", "un", "non", "auto", "end",
  "real", "open", "long", "built", "hands", "high", "low", "full", "data", "event", "cloud",
]);

/** A plain Titlecase word: one capital then lowercase letters only (no internal capitals, digits, #, + or .). */
const PLAIN_TITLECASE = /^\p{Lu}\p{Ll}+$/u;

/** Exempt the whole opening word. A hyphenated opener is exempt when its first part is a known prefix, verb or
 *  stop word (Co-led, Real-time, Cross-functional); otherwise its first part is checked as a normal token
 *  ("Kafka-based" -> Kafka). Words ending in -ly are adverbs (Previously, Recently). */
function exemptAtSentenceStart(sentence: string, t: string): boolean {
  const whole = (sentence.match(/^[^\p{L}\p{N}]*([\p{L}\p{N}][\p{L}\p{N}-]*)/u)?.[1] ?? t).toLowerCase();
  if (!whole.includes("-")) return exemptWord(whole) || (PLAIN_TITLECASE.test(t) && whole.endsWith("ly"));
  if (VERBS.has(whole)) return true;
  const first = whole.split("-")[0]!;
  return WORD_PREFIXES.has(first) || VERBS.has(first) || STOPS.has(first);
}

const SENTENCE_SPLIT = /(?<=[.!?;:])(?<!\be\.g\.|\bi\.e\.|\bvs\.|\betc\.)\s+/i;

/**
 * Returns the numbers and proper nouns in `text` that do not appear in `sources` (numbers first, then nouns).
 * `nounSources` support proper nouns only, never numbers. `openers` are extra sentence openers to exempt;
 * `context` is the rest of the same document: a sentence-initial plain Titlecase word is exempt when its
 * lowercase form appears in the sources or the document ("Slow" / "slow").
 */
export function scanClaims(
  text: string,
  sources: string[],
  opts: { openers?: readonly string[]; context?: string; nounSources?: string[] } = {},
): string[] {
  const openers = new Set((opts.openers ?? []).map((w) => w.toLowerCase()));
  const numberSources = sources.join("\n");
  const joined = [numberSources, ...(opts.nounSources ?? [])].join("\n");
  const lowercaseElsewhere = (t: string) => {
    if (!PLAIN_TITLECASE.test(t)) return false;
    const l = t.toLowerCase();
    return hasToken(joined, l, true) || hasToken(text, l, true) || (opts.context !== undefined && hasToken(opts.context, l, true));
  };
  const sourced = new Set(numbersIn(numberSources, true).map((n) => n.key));
  const numbers: string[] = [];
  const nouns: string[] = [];
  const addTo = (list: string[], t: string) => {
    if (!list.includes(t)) list.push(t);
  };

  for (const n of numbersIn(text, false)) if (!sourced.has(n.key)) addTo(numbers, n.raw);

  for (const sentence of text.split(SENTENCE_SPLIT)) {
    const tokens = sentence.match(TOKEN_RE) ?? [];
    tokens.forEach((raw, i) => {
      const t = raw.replace(/\.+$/, "");
      if (!isProperNoun(t) || isGeneric(t)) return;
      if (i === 0 && (exemptAtSentenceStart(sentence, t) || openers.has(t.toLowerCase()) || lowercaseElsewhere(t))) return;
      if (!hasToken(joined, t, t.length <= 3)) addTo(nouns, t);
    });
  }
  return [...numbers, ...nouns];
}
