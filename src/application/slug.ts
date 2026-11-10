function ascii(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

export function slugify(s: string, max = 40): string {
  const slug = ascii(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const cut = slug.slice(0, max).replace(/-+$/g, "");
  return cut || "unknown";
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
    .replaceAll("{Company}", alnum(company))
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${out}.pdf`;
}
