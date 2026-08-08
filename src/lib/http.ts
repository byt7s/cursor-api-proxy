import * as http from "node:http";

export function extractBearerToken(req: http.IncomingMessage): string | undefined {
  const h = req.headers["authorization"];
  if (h) {
    const val = Array.isArray(h) ? h[0] : h;
    const match = val.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1];
  }
  // Anthropic SDK / CLIProxy-style clients send x-api-key instead of Bearer.
  const xKey = req.headers["x-api-key"];
  if (xKey) {
    const val = Array.isArray(xKey) ? xKey[0] : xKey;
    const trimmed = val.trim();
    return trimmed || undefined;
  }
  return undefined;
}

/** True for the loopback clients allowed to read sensitive routes without a key. */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.trim().toLowerCase();
  return (
    a === "127.0.0.1" ||
    a === "::1" ||
    a === "localhost" ||
    a === "::ffff:127.0.0.1"
  );
}

export function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: http.OutgoingHttpHeaders,
) {
  res.writeHead(status, {
    ...extraHeaders,
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify(body));
}

export function writeSseHeaders(
  res: http.ServerResponse,
  extraHeaders?: http.OutgoingHttpHeaders,
): void {
  res.writeHead(200, {
    ...extraHeaders,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

/** Thrown by `readBody` when the client sends more than `maxBytes`. */
export class BodyTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
    this.maxBytes = maxBytes;
  }
}

/**
 * Buffers the request body, aborting once `maxBytes` is exceeded so a hostile
 * or broken client cannot make the proxy hold an unbounded string in memory.
 * `maxBytes <= 0` reads without a limit.
 */
export async function readBody(
  req: http.IncomingMessage,
  maxBytes = 0,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    req.setEncoding("utf8");
    let overflowed = false;
    req.on("data", (chunk: string) => {
      if (overflowed) return;
      if (maxBytes > 0) {
        bytes += Buffer.byteLength(chunk, "utf8");
        if (bytes > maxBytes) {
          // Drop what was buffered and drain the rest: keeping the socket
          // alive is what lets the caller answer 413 instead of resetting.
          overflowed = true;
          data = "";
          req.resume();
          reject(new BodyTooLargeError(maxBytes));
          return;
        }
      }
      data += chunk;
    });
    req.on("end", () => {
      if (!overflowed) resolve(data);
    });
    req.on("error", (err) => {
      if (!overflowed) reject(err);
    });
  });
}
