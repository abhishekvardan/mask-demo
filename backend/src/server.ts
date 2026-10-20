/** A tiny JSON API over node:http — the Streamlit frontend calls this. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { analytics, protect, restore, ROLES } from "./maskDemo.js";
import { LEVELS, runLevel } from "./kilnDemo.js";
import { loadSample, SAMPLE_NAMES, type Ticket } from "./samples.js";

const PORT = Number(process.env.PORT ?? 8787);

async function body(req: IncomingMessage): Promise<Record<string, string>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

const routes: Record<string, (b: Record<string, string>, url: URL) => Promise<unknown> | unknown> = {
  "GET /api/health": () => ({ ok: true }),
  "GET /api/meta": () => ({
    samples: SAMPLE_NAMES,
    roles: ROLES,
    levels: Object.fromEntries(Object.entries(LEVELS).map(([k, v]) => [k, { title: v.title, description: v.description, privacy: v.privacy ?? null }])),
    tickets: loadSample<Ticket[]>("support_tickets").map((t) => ({ ticket_id: t.ticket_id, subject: t.subject })),
  }),
  "GET /api/sample": (_b, url) => loadSample(url.searchParams.get("name") ?? ""),
  "POST /api/mask/protect": (b) => protect(b.sample),
  "POST /api/mask/restore": (b) => restore(b.sample, b.role),
  "POST /api/mask/analytics": () => analytics(),
  "POST /api/kiln/run": (b) => runLevel(b.level, b.ticket_id, b.role),
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return send(res, 404, { error: `No route ${req.method} ${url.pathname}` });
  try {
    send(res, 200, await handler(req.method === "POST" ? await body(req) : {}, url));
  } catch (error) {
    send(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}).listen(PORT, () => console.log(`mask demo backend on http://localhost:${PORT}`));
