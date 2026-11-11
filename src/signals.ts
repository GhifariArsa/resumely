const handlers: Array<() => void> = [];
let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.on(sig, () => {
      for (const fn of handlers.toReversed()) {
        try {
          fn();
        } catch {
          /* cleanup is best-effort */
        }
      }
      process.exit(code);
    });
  }
}

/** Run `fn` (LIFO with other registered fns) when the process gets SIGINT/SIGTERM, then exit 130/143. Returns an unregister function. */
export function onInterrupt(fn: () => void): () => void {
  install();
  handlers.push(fn);
  return () => {
    const i = handlers.lastIndexOf(fn);
    if (i >= 0) handlers.splice(i, 1);
  };
}
