import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SAMPLES_DIR = fileURLToPath(new URL("../../samples/", import.meta.url));

export const SAMPLE_NAMES = readdirSync(SAMPLES_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();

export function loadSample<T = unknown>(name: string): T {
  if (!SAMPLE_NAMES.includes(name)) throw new Error(`Unknown sample "${name}". Available: ${SAMPLE_NAMES.join(", ")}`);
  return JSON.parse(readFileSync(join(SAMPLES_DIR, `${name}.json`), "utf8")) as T;
}

export interface Customer { customer_id: string; full_name: string; email: string; phone: string; ssn: string; tier: string }
export interface Transaction { txn_id: string; customer_email: string; amount: number; category: string; card_number: string; status: string }
export interface Ticket { ticket_id: string; customer_email: string; subject: string; body: string; priority: string }
