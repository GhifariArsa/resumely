// Progressive enhancement for the application view. Everything here is optional: the page works without it.

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* Trace highlight: a hovered or focused trace row marks itself and every source entry it cites. */
let hovered = null;
let focused = null;

function entriesOf(row) {
  return (row.dataset.entries || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(`entry-${id}`))
    .filter(Boolean);
}

function refreshMarks() {
  for (const el of document.querySelectorAll(".is-marked")) el.classList.remove("is-marked");
  for (const row of new Set([hovered, focused])) {
    if (!row) continue;
    row.classList.add("is-marked");
    for (const el of entriesOf(row)) el.classList.add("is-marked");
  }
}

for (const row of document.querySelectorAll(".trace-row")) {
  row.addEventListener("mouseenter", () => { hovered = row; refreshMarks(); });
  row.addEventListener("mouseleave", () => { if (hovered === row) hovered = null; refreshMarks(); });
  row.addEventListener("focusin", () => { focused = row; refreshMarks(); });
  row.addEventListener("focusout", (e) => {
    if (row.contains(e.relatedTarget)) return;
    if (focused === row) focused = null;
    refreshMarks();
  });
}

document.addEventListener("click", (e) => {
  const chip = e.target instanceof Element ? e.target.closest("a.entry-chip") : null;
  if (!chip) return;
  const target = document.getElementById(decodeURIComponent(chip.hash.slice(1)));
  if (!(target instanceof HTMLDetailsElement)) return;
  e.preventDefault();
  target.open = true;
  target.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
});

/* Copy: buttons are hidden until this module runs, since they do nothing without it. */
function selectPathText(button) {
  const el = button.parentElement?.querySelector(".path") ?? document.querySelector(".version-dir .path");
  if (!el) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

for (const button of document.querySelectorAll("button[data-copy]")) {
  button.hidden = false;
  const label = button.textContent;
  let timer = 0;
  button.addEventListener("click", async () => {
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(button.dataset.copy ?? "");
      button.textContent = "Copied";
      clearTimeout(timer);
      timer = setTimeout(() => { button.textContent = label; }, 1500);
    } catch {
      selectPathText(button);
    }
  });
}

/* Busy state: a long-running form (re-render) disables its button while the request runs. */
const busy = new Map();

document.addEventListener("submit", (e) => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset.busyLabel) return;
  const button = form.querySelector('button[type="submit"], button:not([type])');
  if (!button) return;
  busy.set(button, button.textContent);
  // Disable after the submission has been built, so the browser still sends the form.
  setTimeout(() => {
    button.disabled = true;
    button.textContent = form.dataset.busyLabel;
  }, 0);
});

// Coming back through the history cache must not leave a button stuck in its busy state.
window.addEventListener("pageshow", (e) => {
  if (!e.persisted) return;
  for (const [button, label] of busy) {
    button.disabled = false;
    button.textContent = label;
  }
  busy.clear();
});
