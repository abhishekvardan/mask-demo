/**
 * KILN 0.8.0 with built-in privacy. One support agent, four privacy levels, one caller-role picker.
 * Every response reports exactly what the model saw, what each tool received, what the caller got back and what the
 * event log recorded — read from the run's own events, not reconstructed.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createKiln, defineAgent, defineTool,
  type AgentPrivacyOptions, type ChatMessage, type ChatOptions, type ChatResult, type ProviderAdapter, type RuntimeEvent,
} from "@abhishekvardanbotta/kiln";
import { ROLES } from "./maskDemo.js";
import { loadSample, type Customer, type Ticket, type Transaction } from "./samples.js";

/**
 * A deterministic stand-in for an LLM so the demo runs anywhere, with no GPU or API key. Like a capable model it reads
 * the conversation and copies whatever it sees — real values when privacy is off, placeholders when it is on. It never
 * has any other source of data. Set DEMO_PROVIDER=ollama DEMO_MODEL=qwen2.5:7b to use a real model instead.
 */
class SimulatedModel implements ProviderAdapter {
  public readonly name = "simulated";
  async toolCall(options: ChatOptions): Promise<ChatResult> {
    const msgs = options.messages;
    const user = msgs.find((m) => m.role === "user")?.content ?? "";
    const toolResult = (name: string) => {
      const m = [...msgs].reverse().find((x) => x.role === "tool" && x.name === name);
      return m ? (JSON.parse(m.content) as Record<string, string>) : undefined;
    };
    const lookup = toolResult("lookup_customer");
    const sent = toolResult("send_email");
    const email = user.match(/\[EMAIL_[0-9a-f]+\]|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0];
    if (!lookup) return { content: "", toolCalls: [{ id: "c1", name: "lookup_customer", arguments: { email } }] };
    if (lookup.error) return { content: `I could not look this customer up: ${lookup.error}` };
    if (!sent) {
      return { content: "", toolCalls: [{ id: "c2", name: "send_email", arguments: { to: lookup.email, subject: "Your refund is on its way", body: `Hi ${lookup.full_name}, we are processing your refund. We will text ${lookup.phone} when it settles.` } }] };
    }
    if (sent.error) return { content: `Lookup worked, but the confirmation email failed: ${sent.error}` };
    return { content: `Refund started for ${lookup.full_name} (${lookup.email}, ${lookup.phone}). Card on file ${lookup.card_on_file}; identity verified against SSN ${lookup.ssn}. Confirmation emailed.` };
  }
  chat(o: ChatOptions) { return this.toolCall(o); }
  async json(): Promise<unknown> { return {}; }
  async stream(o: ChatOptions) { return this.toolCall(o); }
  embeddings(): Promise<never> { return Promise.reject(new Error("n/a")); }
  vision(): Promise<never> { return Promise.reject(new Error("n/a")); }
  audio(): Promise<never> { return Promise.reject(new Error("n/a")); }
}

const provider = process.env.DEMO_PROVIDER ?? "simulated";
const model = process.env.DEMO_MODEL ?? "simulated-1";
const kiln = createKiln({ providers: [new SimulatedModel()] });

export const LEVELS: Record<string, { title: string; description: string; privacy?: AgentPrivacyOptions }> = {
  "0-off": {
    title: "Level 0 — privacy off",
    description: "Today's KILN behaviour. The model, tools and logs see everything.",
  },
  "1-defaults": {
    title: "Level 1 — privacy: { enabled: true }",
    description: "Everything personal becomes a placeholder before it leaves the agent. No tool has a grant, so lookup_customer only receives a placeholder and cannot find anyone: privacy fails closed.",
    privacy: { enabled: true },
  },
  "2-tool-grants": {
    title: "Level 2 — + per-tool grants",
    description: "lookup_customer may read EMAIL; send_email may read EMAIL and PERSON. The SSN and card in the lookup result are tokenized before the model reads them.",
    privacy: { enabled: true, tools: { lookup_customer: ["EMAIL"], send_email: ["EMAIL", "PERSON"] } },
  },
  "3-strict": {
    title: "Level 3 — + field policies and BLOCK",
    description: "Card numbers are BLOCKed (removed for everyone, never stored); ticket ids and priorities are declared PUBLIC; the ticket body is scanned as free text.",
    privacy: {
      enabled: true,
      tools: { lookup_customer: ["EMAIL"], send_email: ["EMAIL", "PERSON"] },
      policies: { CREDIT_CARD: "BLOCK" },
      fields: { "ticket.ticket_id": "PUBLIC", "ticket.priority": "PUBLIC", "ticket.channel": "PUBLIC" },
    },
  },
};

export async function runLevel(level: string, ticketId: string, role: string) {
  const config = LEVELS[level];
  if (!config) throw new Error(`Unknown level "${level}". Levels: ${Object.keys(LEVELS).join(", ")}`);
  const grant = ROLES[role];
  if (!grant) throw new Error(`Unknown role "${role}".`);
  const ticket = loadSample<Ticket[]>("support_tickets").find((t) => t.ticket_id === ticketId);
  if (!ticket) throw new Error(`Unknown ticket "${ticketId}".`);
  const customers = loadSample<Customer[]>("customers");
  const transactions = loadSample<Transaction[]>("transactions");

  // Fresh tools per run, so we can record exactly what each one received.
  const received: Record<string, unknown[]> = { lookup_customer: [], send_email: [] };
  const lookupCustomer = defineTool({
    name: "lookup_customer",
    description: "Look up a customer's account by email address.",
    parameters: z.object({ email: z.string() }),
    async execute(input: { email: string }) {
      received.lookup_customer.push(input);
      const c = customers.find((x) => x.email === input.email);
      if (!c) return { error: `no customer with email ${input.email}` };
      const card = transactions.find((t) => t.customer_email === c.email)?.card_number ?? "none";
      return { full_name: c.full_name, email: c.email, phone: c.phone, ssn: c.ssn, tier: c.tier, card_on_file: card };
    },
  });
  const sendEmail = defineTool({
    name: "send_email",
    description: "Send an email to a customer.",
    parameters: z.object({ to: z.string().email(), subject: z.string(), body: z.string() }),
    async execute(input) { received.send_email.push(input); return { delivered: true }; },
  });

  const agent = defineAgent({
    name: "support-agent",
    provider,
    model,
    tools: [lookupCustomer, sendEmail],
    ...(config.privacy ? { privacy: config.privacy } : {}),
    async execute(ctx) {
      const { ticket: t } = ctx.input as { ticket: Ticket };
      ctx.log("ticket_received", t);
      await ctx.memory.set("last_ticket", t);
      const result = await ctx.ai.run({
        maxSteps: 4,
        messages: [
          { role: "system", content: "You are a support agent. Look the customer up by email, email them a refund confirmation addressed by name, then summarize what you did." },
          { role: "user", content: `Ticket ${t.ticket_id} (${t.priority}) from ${t.customer_email}: ${t.subject}\n\n${t.body}` },
        ],
      });
      return { ticket_id: t.ticket_id, reply: result.content };
    },
  });

  const runId = randomUUID();
  const events: Array<{ type: string; event?: string; data: unknown }> = [];
  const off = (["AgentStarted", "AgentLog", "AgentCompleted", "AgentFailed"] as const).map((type) =>
    kiln.events.on(type, (e: RuntimeEvent) => {
      if (e.executionId !== runId) return;
      const p = e.payload as { event?: string; data?: unknown };
      events.push(type === "AgentLog" ? { type, event: p.event, data: p.data } : { type, data: e.payload });
    }));
  const started = performance.now();
  const result = await kiln.runInlineAgent(agent, { ticket }, { runId, privacy: { allow: grant.allow, onDenied: grant.onDenied, principal: `role:${role}` } });
  const ms = performance.now() - started;
  off.forEach((u) => u());

  const modelRequests = events.filter((e) => e.event === "LLMCallCompleted").map((e) => (e.data as { messages: ChatMessage[] }).messages.filter((m) => m.role !== "system"));
  const customer = customers.find((c) => c.email === ticket.customer_email)!;
  const card = transactions.find((t) => t.customer_email === customer.email)?.card_number;
  const rawValues = [customer.full_name, customer.email, customer.phone, customer.ssn, card, ...(ticket.body.match(/Hunter2!x|GB82 WEST 1234 5698 7654 32|cvv 123/g) ?? [])].filter(Boolean) as string[];
  const found = (x: unknown) => rawValues.filter((v) => JSON.stringify(x).includes(v));

  return {
    level, title: config.title, description: config.description, privacyConfig: config.privacy ?? null, role, grant,
    model: `${provider}:${model}`,
    status: result.status,
    ms: Number(ms.toFixed(1)),
    modelRequests,
    toolInputs: received,
    callerOutput: result.status === "succeeded" ? result.output : { error: result.error },
    eventLog: events,
    privacyReport: result.privacy ? { ...result.privacy, redactedInput: undefined, redactedOutput: undefined } : null,
    leakCheck: { rawValuesChecked: rawValues.length, inModelRequests: found(modelRequests), inEventLog: found(events) },
  };
}
