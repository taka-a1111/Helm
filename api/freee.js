// api/freee.js — Helm用 freee収支API（Vercel Serverless Function）
//
// GASを使わず、Helmと同じVercelプロジェクト内で完結させる版。
// 参照専用（freeeへの書き込みは一切しない）。
//
// ■ セットアップ
//  1) このファイルを GitHub の taka-a1111/Helm に api/freee.js として置く
//  2) Vercel → プロジェクト → Settings → Environment Variables に登録
//       FREEE_CLIENT_ID
//       FREEE_CLIENT_SECRET
//       FREEE_REFRESH_TOKEN
//       FREEE_COMPANY_ID      80198
//       HELM_TOKEN            helm-cw-9k4w
//       KV_REST_API_URL       （Vercel KV を接続すると自動で入る）
//       KV_REST_API_TOKEN     （同上）
//  3) 再デプロイ
//
// ■ 使い方
//   GET /api/freee?t=helm-cw-9k4w            … 今年の月次
//   GET /api/freee?t=helm-cw-9k4w&year=2025  … 年を指定
//
// ■ refresh_token のローテーションについて
//   freeeは refresh_token を1回使うと新しいものに差し替える。
//   Vercelの環境変数は実行中に書き換えられないため、更新後のトークンは
//   Vercel KV に保存して次回以降そちらを優先して使う。
//   KVを繋がない場合も動くが、環境変数のトークンが失効した時点で
//   認可からやり直しになるので、KVの接続を推奨。

const TOKEN_URL = "https://accounts.secure.freee.co.jp/public_api/token";
const API = "https://api.freee.co.jp/api/1";
const KV_KEY = "freee:refresh_token";

async function kvGet() {
  const url = process.env.KV_REST_API_URL, tok = process.env.KV_REST_API_TOKEN;
  if (!url || !tok) return null;
  try {
    const r = await fetch(`${url}/get/${KV_KEY}`, { headers: { Authorization: `Bearer ${tok}` } });
    const j = await r.json();
    return j && j.result ? j.result : null;
  } catch { return null; }
}

async function kvSet(value) {
  const url = process.env.KV_REST_API_URL, tok = process.env.KV_REST_API_TOKEN;
  if (!url || !tok) return;
  try {
    await fetch(`${url}/set/${KV_KEY}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  } catch {}
}

async function accessToken() {
  const refresh = (await kvGet()) || process.env.FREEE_REFRESH_TOKEN;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: process.env.FREEE_CLIENT_ID,
    client_secret: process.env.FREEE_CLIENT_SECRET,
    refresh_token: refresh,
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
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
    const nowJst = new Date(Date.now() + 9 * 3600 * 1000);
    const year = Number(req.query.year) || nowJst.getUTCFullYear();
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
    const cur = `${year}-${String(nowJst.getUTCMonth() + 1).padStart(2, "0")}`;
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
