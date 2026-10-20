"""Streamlit frontend for the mask / KILN 0.8.0 privacy demo. Start the backend first (see README)."""
import json
import os

import pandas as pd
import requests
import streamlit as st

BACKEND = os.environ.get("BACKEND_URL", "http://localhost:8787")

st.set_page_config(page_title="mask — privacy demo", page_icon="🛡️", layout="wide")


def api(method: str, path: str, **payload):
    try:
        r = requests.request(method, f"{BACKEND}{path}", json=payload or None, timeout=120)
    except requests.ConnectionError:
        st.error(f"Backend not reachable at {BACKEND}. Start it with `cd backend && npm start`.")
        st.stop()
    data = r.json()
    if r.status_code != 200:
        st.error(data.get("error", r.text))
        st.stop()
    return data


meta = api("GET", "/api/meta")

st.title("🛡️ mask — hide personal data, keep everything else")
st.caption(
    "**@abhishekvardanbotta/mask** finds personal data, swaps it for stable placeholders and keeps the originals "
    "encrypted. **KILN 0.8.0** applies it automatically to every model call, tool call, memory write and log line. "
    "All data below is fake sample data from `samples/`."
)

tab_mask, tab_analytics, tab_kiln = st.tabs(["① Standalone mask", "② Analytics without loss", "③ KILN 0.8.0 privacy levels"])

# ---------------------------------------------------------------------------------------------------------------
with tab_mask:
    st.subheader("Mask a dataset, then restore it per role")
    sample = st.selectbox("Sample file", meta["samples"], index=meta["samples"].index("support_tickets"))
    result = api("POST", "/api/mask/protect", sample=sample)
    summary = result["summary"]

    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Values tokenized", summary["tokenized"])
    c2.metric("Values blocked", summary["blocked"])
    c3.metric("Masking time", f"{result['ms']} ms")
    c4.metric("Round trip", "exact" if result["lossless"] else f"exact except {summary['blocked']} BLOCKed")
    st.write("**Types found:** " + ", ".join(f"`{t}`" for t in summary["types"]))
    if not result["lossless"]:
        st.info(
            "BLOCKed values (passwords, card security codes) are removed on purpose and never stored, so nobody can "
            "restore them. Every other value comes back exactly."
        )

    left, right = st.columns(2)
    with left:
        st.markdown("**Original**")
        st.json(result["raw"], expanded=1)
    with right:
        st.markdown("**What leaves your system (model, logs, analytics)**")
        st.json(result["masked"], expanded=1)

    st.divider()
    st.subheader("Same masked data, different people")
    role = st.radio("View as", list(meta["roles"]), horizontal=True)
    st.caption(meta["roles"][role]["description"] + f"  Grants: `{meta['roles'][role]['allow']}`")
    st.json(api("POST", "/api/mask/restore", sample=sample, role=role)["view"], expanded=1)

    with st.expander("What the vault actually stores (AES-256-GCM ciphertext, never plaintext)"):
        st.json(result["vaultRecordExample"])
    with st.expander("Audit trail (tokens and types, never values)"):
        st.dataframe(pd.DataFrame(result["audit"]), width="stretch")

# ---------------------------------------------------------------------------------------------------------------
with tab_analytics:
    st.subheader("Run the same analytics on raw and on masked data")
    st.write(
        "`transactions.json` and `support_tickets.json` are masked **together**. The same email becomes the same "
        "placeholder in both, so group-bys, distinct counts and joins still work. The analyst only ever sees the "
        "masked side."
    )
    a = api("POST", "/api/mask/analytics")
    ok = sum(c["identical"] for c in a["checks"])
    c1, c2 = st.columns(2)
    c1.metric("Metrics identical", f"{ok} / {len(a['checks'])}")
    c2.metric("Raw emails or card numbers visible to the analyst", len(a["rawValuesVisibleToAnalyst"]))
    st.dataframe(
        pd.DataFrame([{"metric": c["metric"], "identical on masked data": "✅" if c["identical"] else "❌"} for c in a["checks"]]),
        width="stretch", hide_index=True,
    )

    left, right = st.columns(2)
    for col, key, label in [(left, "onRaw", "Computed on raw data"), (right, "onMasked", "Computed on masked data (analyst's view)")]:
        with col:
            st.markdown(f"**{label}**")
            m = a[key]
            st.dataframe(
                pd.DataFrame({
                    "revenue": m["revenue_by_customer"],
                    "transactions": m["transactions_by_customer"],
                    "distinct cards": m["distinct_cards_by_customer"],
                }).sort_values("revenue", ascending=False),
                width="stretch",
            )
            st.write(f"Total revenue **{m['total_revenue']}**, refund rate **{m['refund_rate']}**, top customer `{m['top_customer']['customer']}`")
    with st.expander("Masked transactions (first 5 rows)"):
        st.dataframe(pd.DataFrame(a["maskedSample"]), width="stretch")

# ---------------------------------------------------------------------------------------------------------------
with tab_kiln:
    st.subheader("One support agent, four privacy levels")
    levels = meta["levels"]
    c1, c2, c3 = st.columns([2, 1, 1])
    level = c1.radio("Level", list(levels), format_func=lambda k: levels[k]["title"])
    ticket = c2.selectbox("Ticket", [t["ticket_id"] for t in meta["tickets"]],
                          format_func=lambda t: f"{t} — {next(x['subject'] for x in meta['tickets'] if x['ticket_id'] == t)}")
    role = c3.selectbox("Caller role", list(meta["roles"]))
    st.info(levels[level]["description"])
    st.code(
        "defineAgent({ ...," + ("" if levels[level]["privacy"] is None else f"\n  privacy: {json.dumps(levels[level]['privacy'], indent=2)}") + "\n})",
        language="ts",
    )

    run = api("POST", "/api/kiln/run", level=level, ticket_id=ticket, role=role)
    leaks = run["leakCheck"]
    m1, m2, m3 = st.columns(3)
    m1.metric("Raw values in model requests", len(leaks["inModelRequests"]), delta=None)
    m2.metric("Raw values in the event log", len(leaks["inEventLog"]))
    m3.metric("Run time", f"{run['ms']} ms", help=f"model: {run['model']}")

    st.markdown("#### 1 · What the model received")
    first = next(m["content"] for m in run["modelRequests"][0] if m["role"] == "user")
    st.code(first, language="text")
    tool_msgs = [m for req in run["modelRequests"] for m in req if m["role"] == "tool"]
    if tool_msgs:
        st.markdown("Tool results, as the model read them:")
        for m in tool_msgs:
            st.code(f"{m['name']} → {m['content']}", language="json")

    st.markdown("#### 2 · What the tools received")
    t1, t2 = st.columns(2)
    t1.markdown("`lookup_customer`")
    t1.json(run["toolInputs"]["lookup_customer"])
    t2.markdown("`send_email`")
    t2.json(run["toolInputs"]["send_email"])

    st.markdown(f"#### 3 · What the caller (`{role}`) got back")
    out = run["callerOutput"]
    st.success(out.get("reply", json.dumps(out)))

    with st.expander("4 · The event log as stored (traces, `kiln logs`, dashboards)"):
        for e in run["eventLog"]:
            st.code(f"{e['type']}{' · ' + e['event'] if e.get('event') else ''}\n{json.dumps(e['data'], indent=1)[:1500]}", language="json")
    if run["privacyReport"]:
        with st.expander("Privacy report on the run result"):
            st.json(run["privacyReport"])

    st.divider()
    if st.button("Compare all four levels for this ticket and role"):
        rows = []
        for lv in levels:
            r = api("POST", "/api/kiln/run", level=lv, ticket_id=ticket, role=role)
            rows.append({
                "level": levels[lv]["title"],
                "raw values sent to model": len(r["leakCheck"]["inModelRequests"]),
                "raw values in logs": len(r["leakCheck"]["inEventLog"]),
                "email sent": bool(r["toolInputs"]["send_email"]),
                "caller got": r["callerOutput"].get("reply", "")[:120],
            })
        st.dataframe(pd.DataFrame(rows), width="stretch", hide_index=True)
