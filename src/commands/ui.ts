import { UserError } from "../errors";
import { DEFAULT_UI_PORT, startUiServer } from "../ui/server";
import { openFile } from "./open";

export function parsePort(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n > 65535) throw new UserError(`Invalid --port "${v}"`, "Use a number from 0 to 65535 (0 = any free port)");
  return n;
}

/** Serve the local viewer until Ctrl-C. Never resolves; SIGINT/SIGTERM stop the server and exit 0. */
export async function runUi(o: { root: string; port?: number; open: boolean }): Promise<void> {
  const server = startUiServer({ root: o.root, port: o.port, preferredPort: DEFAULT_UI_PORT });
  console.log(`resumely ui running at ${server.url}`);
  console.log("Press Ctrl-C to stop.");
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return; // a repeated signal while stop() is pending must not stop twice
    stopping = true;
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (o.open) await openFile(server.url);
  await new Promise<never>(() => {});
}
