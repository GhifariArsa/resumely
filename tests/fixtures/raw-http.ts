import { connect } from "node:net";

/**
 * Sends `head` (request line + headers, each ending in CRLF) verbatim over a socket, so the path and Host
 * reach the server exactly as written — `fetch` would normalise `..` and set its own Host.
 */
export function rawRequest(port: number, head: string): Promise<{ status: number; headers: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("data", (d) => chunks.push(Buffer.from(d)));
    socket.on("error", reject);
    socket.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const split = text.indexOf("\r\n\r\n");
      const top = split === -1 ? text : text.slice(0, split);
      const [statusLine = "", ...rest] = top.split("\r\n");
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1] ?? NaN);
      resolve({ status, headers: rest.join("\r\n"), body: split === -1 ? "" : text.slice(split + 4) });
    });
    socket.write(`${head}Connection: close\r\n\r\n`);
  });
}
