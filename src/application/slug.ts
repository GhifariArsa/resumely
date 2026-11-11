const TRANSLIT: Record<string, string> = {
  "ß": "ss", "ẞ": "SS", "ø": "o", "Ø": "O", "æ": "ae", "Æ": "AE", "œ": "oe", "Œ": "OE",
  "ł": "l", "Ł": "L", "đ": "d", "Đ": "D", "þ": "th", "Þ": "Th", "ð": "d", "Ð": "D", "ı": "i",
};
const TRANSLIT_RE = new RegExp(`[${Object.keys(TRANSLIT).join("")}]`, "g");

function ascii(s: string): string {
  return s.replace(TRANSLIT_RE, (c) => TRANSLIT[c]!).normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

export function slugify(s: string, max = 40): string {
  const slug = ascii(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const cut = slug.slice(0, max).replace(/-+$/g, "");
  return cut || "unknown";
}

/** The agency of a "Confidential (via <agency>)" posting, else null. */
export function agencyOf(company: string): string | null {
  return /^Confidential \(via (.+)\)$/i.exec(company.trim())?.[1]?.trim() ?? null;
}

function alnum(s: string): string {
  return ascii(s).replace(/[^A-Za-z0-9]/g, "");
}

export function sendReadyName(
  pattern: string,
  about: { name: string },
  kind: "Resume" | "Cover_Letter",
  company: string,
): string {
  const words = about.name.trim().split(/\s+/).filter(Boolean);
  const first = alnum(words[0] ?? "");
  const last = words.length > 1 ? alnum(words[words.length - 1]!) : "";
  const out = pattern
    .replaceAll("{First}", first)
    .replaceAll("{Last}", last)
    .replaceAll("{Kind}", kind)
    .replaceAll("{Company}", alnum(agencyOf(company) ?? company))
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${out}.pdf`;
}
