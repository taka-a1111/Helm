// api/freee.js — Helm用 freee収支API（Vercel Serverless Function）
//
// freeeの「取引」から月ごとの 収入 / 支出 / 差引 を集計して返す。参照専用。
// refresh_token は1回使うと差し替わるため、更新後の値をSupabase（helm_kv）へ保存する。
//
// 必要な環境変数
//   FREEE_CLIENT_ID / FREEE_CLIENT_SECRET / FREEE_COMPANY_ID
//   FREEE_REFRESH_TOKEN … 初回のみ使う種。以降はSupabase側が正。
//   HELM_TOKEN          … このAPIを叩くための合言葉
//   SUPABASE_URL / SUPABASE_KEY / SUPABASE_KV_TOKEN

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
  const stored = await kvGet();
  const refresh = stored || process.env.FREEE_REFRESH_TOKEN;
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

async function fetchDeals(token, type, from, to) {
  const cid = process.env.FREEE_COMPANY_ID;
  let out = [], offset = 0;
  for (let i = 0; i < 30; i++) {
    const u = `${API}/deals?company_id=${cid}&type=${type}` +
      `&start_issue_date=${from}&end_issue_date=${to}&limit=100&offset=${offset}`;
    const r = await fetch(u, { headers: { Authorization: `Bearer ${token}`, accept: "application/json" } });
    if (!r.ok) throw new Error(`${type}: ${r.status} ${await r.text()}`);
    const ds = (await r.json()).deals || [];
    out = out.concat(ds);
    if (ds.length < 100) break;
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
    const jst = new Date(Date.now() + 9 * 3600 * 1000);
    const year = Number(req.query.year) || jst.getUTCFullYear();
    const token = await accessToken();
    const [inc, exp] = await Promise.all([
      fetchDeals(token, "income", `${year}-01-01`, `${year}-12-31`),
      fetchDeals(token, "expense", `${year}-01-01`, `${year}-12-31`),
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
    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=86400");
    return res.status(200).json({ ok: true, year, current, ytd, months, fetchedAt: new Date().toISOString() });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
