// api/freee.js — Helm用 freee収支API（Vercel Serverless Function）
//
// freeeの「取引」から月ごとの 収入 / 支出 / 差引 を集計して返す。参照専用。
// あわせて「自動で経理」の未処理明細（＝まだ経費として計上されていない分）の件数も返す。
// refresh_token は1回使うと差し替わるため、更新後の値をSupabase（helm_kv）へ保存する。

const TOKEN_URL = "https://accounts.secure.freee.co.jp/public_api/token";
const API = "https://api.freee.co.jp/api/1";
const KV_KEY = "freee:refresh_token";

async function rpc(fn, body) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...body, tok: process.env.SUPABASE_KV_TOKEN }),
  });
  if (!r.ok) throw new Error(`kv ${fn}: ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

const kvGet = async () => { try { return await rpc("helm_kv_get", { k: KV_KEY }); } catch { return null; } };
const kvSet = async (v) => { try { await rpc("helm_kv_set", { k: KV_KEY, v }); } catch {} };

async function accessToken() {
  const refresh = (await kvGet()) || process.env.FREEE_REFRESH_TOKEN;
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.FREEE_CLIENT_ID,
      client_secret: process.env.FREEE_CLIENT_SECRET,
      refresh_token: refresh,
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("token: " + JSON.stringify(j));
  if (j.refresh_token) await kvSet(j.refresh_token);
  return j.access_token;
}

async function pageAll(token, path) {
  let out = [], offset = 0;
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${API}${path}&limit=100&offset=${offset}`, {
      headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
    const j = await r.json();
    const key = Object.keys(j).find((k) => Array.isArray(j[k]));
    const arr = key ? j[key] : [];
    out = out.concat(arr);
    if (arr.length < 100) break;
    offset += 100;
  }
  return out;
}

const byMonth = (deals) => deals.reduce((m, d) => {
  const k = String(d.issue_date || "").slice(0, 7);
  if (k) m[k] = (m[k] || 0) + (Number(d.amount) || 0);
  return m;
}, {});

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    if ((req.query.t || "") !== process.env.HELM_TOKEN) {
      return res.status(401).json({ ok: false, error: "bad token" });
    }
    const cid = process.env.FREEE_COMPANY_ID;
    const jst = new Date(Date.now() + 9 * 3600 * 1000);
    const year = Number(req.query.year) || jst.getUTCFullYear();
    const token = await accessToken();
    const [inc, exp] = await Promise.all([
      pageAll(token, `/deals?company_id=${cid}&type=income&start_issue_date=${year}-01-01&end_issue_date=${year}-12-31`),
      pageAll(token, `/deals?company_id=${cid}&type=expense&start_issue_date=${year}-01-01&end_issue_date=${year}-12-31`),
    ]);
    const I = byMonth(inc), E = byMonth(exp);
    const months = [];
    for (let i = 1; i <= 12; i++) {
      const k = `${year}-${String(i).padStart(2, "0")}`;
      const a = I[k] || 0, b = E[k] || 0;
      if (a || b) months.push({ month: k, income: a, expense: b, net: a - b });
    }
    const cur = `${year}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}`;
    const current = months.find((m) => m.month === cur) || { month: cur, income: 0, expense: 0, net: 0 };
    const ytd = months.reduce((s, m) => ({
      income: s.income + m.income, expense: s.expense + m.expense, net: s.net + m.net,
    }), { income: 0, expense: 0, net: 0 });

    // 「自動で経理」の未処理明細（status=1）。ここが残っていると収支が実態より黒字に見える
    let pending = { count: 0, amount: 0 };
    try {
      const from = `${cur}-01`;
      const last = new Date(Date.UTC(year, jst.getUTCMonth() + 1, 0)).getUTCDate();
      const txns = await pageAll(token, `/wallet_txns?company_id=${cid}&start_date=${from}&end_date=${cur}-${last}`);
      const un = txns.filter((x) => x.status === 1 && x.entry_side === "expense");
      pending = { count: un.length, amount: un.reduce((s, x) => s + (Number(x.amount) || 0), 0) };
    } catch { /* 権限不足等では黙って0のまま */ }

    // 口座残高（freeeが最後に同期した時点の残高）
    let balances = [];
    try {
      const r = await fetch(`${API}/walletables?company_id=${cid}&with_balance=true`, {
        headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
      });
      if (r.ok) {
        const ws = (await r.json()).walletables || [];
        balances = ws
          .filter((w) => w.type === "bank_account")
          .map((w) => ({ name: w.name, balance: Number(w.last_balance) || 0, syncedAt: w.last_synced_at || null }));
      }
    } catch { /* 取れなければ空のまま */ }
    const cash = balances.reduce((s2, b) => s2 + b.balance, 0);

    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=86400");
    return res.status(200).json({ ok: true, year, current, ytd, months, pending, balances, cash, fetchedAt: new Date().toISOString() });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
