const handlers: Array<() => void> = [];
const SIGNALS = [["SIGINT", 130], ["SIGTERM", 143]] as const;
/** The process listeners while any handler is registered; removed when the last one unregisters so default Ctrl-C behaviour returns. */
let listeners: Array<[NodeJS.Signals, () => void]> | undefined;

function install(): void {
  if (listeners) return;
  listeners = SIGNALS.map(([sig, code]) => [
    sig,
    () => {
      for (const fn of handlers.toReversed()) {
        try {
          fn();
        } catch {
          /* cleanup is best-effort */
        }
      }
      process.exit(code);
    },
  ]);
  for (const [sig, l] of listeners) process.on(sig, l);
}

function uninstall(): void {
  if (!listeners) return;
  for (const [sig, l] of listeners) process.off(sig, l);
  listeners = undefined;
}

/** Run `fn` (LIFO with other registered fns) when the process gets SIGINT/SIGTERM, then exit 130/143. Returns an unregister function. */
export function onInterrupt(fn: () => void): () => void {
  install();
  handlers.push(fn);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const i = handlers.lastIndexOf(fn);
    if (i >= 0) handlers.splice(i, 1);
    if (handlers.length === 0) uninstall();
  };
}
