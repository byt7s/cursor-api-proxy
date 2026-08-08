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

export async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
