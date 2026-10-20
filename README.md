# mask — privacy demo

**Hide personal data from LLMs, tools, logs and analysts without losing any of the data's usefulness.**

This repo is a small, runnable showcase for two npm packages:

- **[`@abhishekvardanbotta/mask`](https://www.npmjs.com/package/@abhishekvardanbotta/mask)** is a standalone library. It finds personal data in JSON and free text, replaces each value with a stable placeholder (`ss1_kqfmzxat`), keeps the original encrypted (AES-256-GCM), and restores it only for people allowed to see it.
- **[`@abhishekvardanbotta/kiln`](https://www.npmjs.com/package/@abhishekvardanbotta/kiln) 0.7.1** is an AI-agent framework with mask built in. Adding `privacy: { enabled: true }` to an agent applies it to every model call, tool call, memory write and log line.

It has a Node backend (`backend/`), a Streamlit frontend (`frontend/`), and fake sample data (`samples/`).

```
samples/            customers.json · transactions.json · support_tickets.json · medical_intake.json   (all fake)
backend/src/
  maskDemo.ts       standalone mask: protect, restore per role, analytics parity
  kilnDemo.ts       KILN 0.7.1 support agent at four privacy levels
  server.ts         JSON API on :8787
frontend/app.py     Streamlit UI with three tabs
```

## Run it

You need Node 20.3+ and Python 3.10+.

```sh
# 1. backend
cd backend
npm install
npm start                      # -> http://localhost:8787

# 2. frontend (second terminal)
cd frontend
pip install -r requirements.txt
streamlit run app.py           # -> http://localhost:8501
```

No API key or GPU is needed. The KILN agent uses a deterministic **simulated model** by default. It behaves like a capable LLM that copies whatever it is shown, real values or placeholders, and has no other source of data. To use a real model instead:

```sh
DEMO_PROVIDER=ollama DEMO_MODEL=qwen2.5:7b npm start      # needs `ollama serve`
```

## What you will see

### ① Standalone mask

Pick a sample file. You see the original next to what would leave your system:

```text
original : I am Aisha Khan. Refund to IBAN GB82 WEST 1234 5698 7654 32 please. My SSN is 789-12-3456 if you need to verify.
masked   : I am ss1_lgsogrhd. Refund to IBAN ss1_rrnnqohn please. My SSN is ss1_rabotsfi if you need to verify.
```

The same masked data can then be restored for different roles:

| Role | Sees in the clear | Everything else |
|---|---|---|
| `support` | names, emails, phones, addresses | masked (`**** **** **** 1111`, `***-**-6789`) |
| `billing` | + card numbers, IBANs, bank accounts | masked |
| `compliance` | everything restorable | — |
| `analyst` | nothing | stable placeholders (see ②) |

The tab also shows:

- the round-trip check: restore(mask(data)) equals data exactly
- a vault record, which is ciphertext only
- the audit trail, which records tokens and types, never values

**Two values never come back:** the password in ticket T-503 and the card security code in T-506. They are `BLOCK`ed: removed on purpose and never stored, following PCI DSS for card security codes. That is why `support_tickets` reports "exact except 2 BLOCKed".

### ② Analytics without loss

`transactions.json` (48 rows) and `support_tickets.json` are masked together. The same email becomes the same placeholder in both files, so analytics run on the masked data give **the same answers** as on the raw data:

| Metric | Identical on masked data |
|---|---|
| total revenue, transaction count, refund rate, revenue by category | ✅ |
| distinct customers, revenue and transactions per customer | ✅ |
| distinct cards per customer, cards shared between customers | ✅ |
| support tickets joined to transactions (cross-file join on email) | ✅ |
| top customer | ✅ (an `ss1_` token, which is Priya Sharma, with 3138.34) |

The analyst sees zero raw emails or card numbers. The backend proves parity by mapping the masked results' keys back and comparing all 11 metrics. Only the identity labels are hidden; nothing else is lost.

### ③ KILN 0.7.1 privacy levels

One support agent handles a ticket. It looks the customer up, emails a refund confirmation, and summarizes. Choose a level, a ticket and a caller role:

| Level | Config | What happens (ticket T-501) |
|---|---|---|
| 0 — off | *(none)* | The model and the logs receive the name, email, phone, SSN and card. |
| 1 — defaults | `privacy: { enabled: true }` | The model sees `ss1_` tokens such as `ss1_japvsodb`. No tool has a grant, so `lookup_customer` only gets a token and finds nobody. **Privacy fails closed.** |
| 2 — tool grants | `+ tools: { lookup_customer: ["EMAIL"], send_email: ["EMAIL", "PERSON"] }` | Each tool receives exactly what it is granted. The SSN and card in the lookup result are tokenized before the model reads them. |
| 3 — strict | `+ policies: { CREDIT_CARD: "BLOCK" }, fields: { "ticket.ticket_id": "PUBLIC", … }` | Card numbers are removed for everyone, including the caller. Passwords and card security codes are always blocked. |

At level 2, the email body says "we will text **ss1_ollqkahj**". `send_email` was granted `EMAIL` and `PERSON` but not `PHONE`, so the phone number stays a placeholder even inside the email. Grants are exact. Add `"PHONE"` if the email should contain it.

For each run, the tab shows:

1. What the model received: the prompt and every tool result as the model read it.
2. What each tool actually received.
3. What the caller got back. This depends on the role: `support` sees `***-**-7891` for the SSN, `compliance` sees it in full, and `analyst` sees only placeholders.
4. The event log as stored, which feeds traces, `kiln logs` and dashboards.

There is also a leak counter: raw customer values found in model requests and in the log. It reads **5 or 6 at level 0, and 0 at levels 1–3, for every ticket.**

The agent code is the same at every level. Only the `privacy` option changes:

```ts
const agent = defineAgent({
  name: "support-agent", provider, model, tools: [lookupCustomer, sendEmail],
  privacy: { enabled: true, tools: { lookup_customer: ["EMAIL"], send_email: ["EMAIL", "PERSON"] } },
  async execute(ctx) {
    const { ticket } = ctx.input as { ticket: Ticket };
    const result = await ctx.ai.run({ messages: [/* system prompt */, { role: "user", content: ticket.body }] });
    return { reply: result.content };
  },
});

// Who is asking decides what comes back:
await kiln.runInlineAgent(agent, { ticket }, { privacy: { allow: ["PII"], onDenied: "mask", principal: "role:support" } });
```

## API

| | |
|---|---|
| `GET /api/meta` | samples, roles, levels, tickets |
| `GET /api/sample?name=customers` | a raw sample file |
| `POST /api/mask/protect {"sample"}` | masked data, summary, round-trip check, vault record, audit |
| `POST /api/mask/restore {"sample","role"}` | the masked sample as a role sees it |
| `POST /api/mask/analytics` | 11 metrics on raw versus masked data, with an identity check per metric |
| `POST /api/kiln/run {"level","ticket_id","role"}` | model requests, tool inputs, caller output, event log, leak check |

## Honest limits

- **Detection is good, not perfect.** A bare name in free text with no cue ("Priya called yesterday") is not found by the built-in rules. Classified fields (`full_name`), cues ("my name is", "Customer …", "Dr.") and pluggable NER detectors cover it.
- **The simulated model is deterministic**, so the demo is reproducible. With real models, the KILN eval in the kiln repo measured:
  - `qwen2.5:7b`: the same task success with privacy on as off
  - `qwen2.5:3b`: worse with the default `ss1_` tokens (2/5 versus 5/5 without privacy), because it has to infer what each token is; close to baseline with `tokenStyle: "sequential"` (`[EMAIL_1]`, 4/5)
  - 5 trials per arm; run it on your own model before relying on it.
- **Placeholders are pseudonymous, not anonymous.** While the vault and key exist, they are reversible by design. This demo uses a random per-process key.
- This is not a compliance certification.

## License

MIT
