/**
 * Standalone @abhishekvardanbotta/mask — no agent framework involved.
 *   protect():   mask a sample dataset and show what was found
 *   restore():   give the same masked data back to different roles
 *   analytics(): run the same analytics on raw and on masked data and prove the numbers are identical
 */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createPrivacy, InMemoryVaultStore, type Grant, type DeniedMode } from "@abhishekvardanbotta/mask";
import { loadSample, type Ticket, type Transaction } from "./samples.js";

const store = new InMemoryVaultStore();
// A fixed key would come from a secrets manager in production (KILN_PRIVACY_KEY); random per process is fine for a demo.
const privacy = createPrivacy({ store });

export const ROLES: Record<string, { allow: Grant[]; onDenied: DeniedMode; description: string }> = {
  support: { allow: ["PII"], onDenied: "mask", description: "Contact details in the clear; card numbers, SSNs and health data masked." },
  billing: { allow: ["PII", "CREDIT_CARD", "IBAN", "BANK_ACCOUNT"], onDenied: "mask", description: "Adds payment instruments; still no SSNs or health data." },
  compliance: { allow: ["PII", "SENSITIVE"], onDenied: "redact", description: "Everything restorable (BLOCKed values are gone for everyone)." },
  analyst: { allow: [], onDenied: "token", description: "Nothing in the clear. Keeps stable pseudonymous tokens, so every aggregate still works." },
};

/**
 * A fresh scope per request, destroyed afterwards (data minimization). Numbering is deterministic in processing order,
 * so the same sample always masks to the same placeholders, and per-request counts stay accurate.
 */
const scopeFor = (sample: string) => `demo:${sample}:${randomUUID()}`;

export async function protect(sample: string) {
  const raw = loadSample(sample);
  const scope = scopeFor(sample);
  const session = privacy.session(scope);
  const started = performance.now();
  const masked = await session.protect(raw);
  const ms = performance.now() - started;
  const record = store.list(scope)[0];
  const lossless = isDeepStrictEqual(session.restore(masked, { trusted: true }), raw);
  const summary = session.summary();
  const audit = session.audit().slice(-8);
  await privacy.destroy(scope);
  return {
    sample,
    raw,
    masked,
    ms: Number(ms.toFixed(2)),
    summary,
    lossless,
    vaultRecordExample: record ?? null,
    audit,
  };
}

export async function restore(sample: string, role: string) {
  const grant = ROLES[role];
  if (!grant) throw new Error(`Unknown role "${role}". Roles: ${Object.keys(ROLES).join(", ")}`);
  const scope = scopeFor(sample);
  const session = privacy.session(scope);
  try {
    const masked = await session.protect(loadSample(sample));
    return { sample, role, grant, view: session.restore(masked, { allow: grant.allow, onDenied: grant.onDenied, principal: `role:${role}` }) };
  } finally {
    await privacy.destroy(scope);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Analytics parity
// ---------------------------------------------------------------------------------------------------------------

const round = (n: number) => Math.round(n * 100) / 100;

function metrics(transactions: Transaction[], tickets: Ticket[]) {
  const revenue: Record<string, number> = {};
  const count: Record<string, number> = {};
  const cards: Record<string, Set<string>> = {};
  const byCategory: Record<string, number> = {};
  let refunded = 0;
  for (const t of transactions) {
    if (t.status === "settled") revenue[t.customer_email] = round((revenue[t.customer_email] ?? 0) + t.amount);
    count[t.customer_email] = (count[t.customer_email] ?? 0) + 1;
    (cards[t.customer_email] ??= new Set()).add(t.card_number);
    byCategory[t.category] = round((byCategory[t.category] ?? 0) + t.amount);
    if (t.status === "refunded") refunded++;
  }
  // A join across two datasets on the (masked) email column.
  const ticketsWithHistory = Object.fromEntries(tickets.map((k) => [k.ticket_id, transactions.filter((t) => t.customer_email === k.customer_email).length]));
  const shared = Object.entries(cards).flatMap(([who, set]) => [...set].map((card) => [card, who] as const));
  const cardOwners: Record<string, Set<string>> = {};
  for (const [card, who] of shared) (cardOwners[card] ??= new Set()).add(who);
  const sharedCards = Object.values(cardOwners).filter((owners) => owners.size > 1).length;
  const top = Object.entries(revenue).sort((a, b) => b[1] - a[1])[0];
  return {
    total_revenue: round(transactions.filter((t) => t.status === "settled").reduce((s, t) => s + t.amount, 0)),
    transactions: transactions.length,
    distinct_customers: Object.keys(count).length,
    refund_rate: round(refunded / transactions.length),
    revenue_by_customer: revenue,
    transactions_by_customer: count,
    distinct_cards_by_customer: Object.fromEntries(Object.entries(cards).map(([k, v]) => [k, v.size])),
    revenue_by_category: byCategory,
    cards_shared_between_customers: sharedCards,
    tickets_joined_to_transactions: ticketsWithHistory,
    top_customer: top ? { customer: top[0], revenue: top[1] } : null,
  };
}

/** Renames the keys (and `top_customer.customer`) of a metrics object with `fn` — used to map tokens back for comparison. */
function mapKeys(m: ReturnType<typeof metrics>, fn: (key: string) => string) {
  const remap = <V>(o: Record<string, V>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [fn(k), v]));
  return { ...m, revenue_by_customer: remap(m.revenue_by_customer), transactions_by_customer: remap(m.transactions_by_customer), distinct_cards_by_customer: remap(m.distinct_cards_by_customer), top_customer: m.top_customer && { ...m.top_customer, customer: fn(m.top_customer.customer) } };
}

export async function analytics() {
  const transactions = loadSample<Transaction[]>("transactions");
  const tickets = loadSample<Ticket[]>("support_tickets");
  // Both datasets in ONE scope: the same email becomes the same token in both, so joins survive masking.
  const scope = `analytics:${randomUUID()}`;
  const session = privacy.session(scope);
  try {
    const maskedTransactions = (await session.protect(transactions)) as Transaction[];
    const maskedTickets = (await session.protect(tickets)) as Ticket[];

    const onRaw = metrics(transactions, tickets);
    const onMasked = metrics(maskedTransactions, maskedTickets);
    // The analyst only ever sees onMasked. To *prove* nothing was lost, map its token keys back and compare.
    const onMaskedRestored = mapKeys(onMasked, (k) => session.restore(k, { trusted: true }) as string);

    const checks = Object.keys(onRaw).map((metric) => ({
      metric,
      identical: isDeepStrictEqual((onRaw as Record<string, unknown>)[metric], (onMaskedRestored as Record<string, unknown>)[metric]),
    }));
    const rawValues = [...new Set(transactions.flatMap((t) => [t.customer_email, t.card_number]))];
    const leakedIntoMasked = rawValues.filter((v) => JSON.stringify([maskedTransactions, maskedTickets, onMasked]).includes(v));
    return {
      checks,
      allIdentical: checks.every((c) => c.identical),
      onRaw,
      onMasked,
      maskedSample: maskedTransactions.slice(0, 5),
      rawValuesVisibleToAnalyst: leakedIntoMasked,
    };
  } finally {
    await privacy.destroy(scope);
  }
}
