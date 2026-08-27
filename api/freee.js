// api/freee.js — Helm用 freee収支API（Vercelサーバーレス関数）
//
// 役割：freeeの「取引」から月ごとの 収入 / 支出 / 差引 を集計して返すだけ。参照専用。
//
// ■ Vercelの環境変数（Settings → Environment Variables）
//   FREEE_CLIENT_ID       792012945509393
//   FREEE_CLIENT_SECRET   （アプリ詳細のClient Secret）
//   FREEE_REFRESH_TOKEN   （初回に取得したrefresh_token）
//   FREEE_COMPANY_ID      80198
//   HELM_TOKEN            helm-cw-9k4w
//
// ■ 呼び出し
//   /api/freee?t=helm-cw-9k4w            … 今年の月次
//   /api/freee?t=helm-cw-9k4w&year=2025  … 年を指定
//
// ■ refresh_tokenのローテーションについて
//   freeeはrefresh_tokenを使うたびに新しいものへ入れ替える。Vercelの関数からは
//   環境変数を書き換えられないため、取得した新しいtokenはSupabaseの helm_secrets に保存する。
//   （テーブルが無い場合は環境変数のtokenを使い続けるので、期限切れ時に再設定が必要）

const FREEE_API = "https://api.freee.co.jp/api/1";
const FREEE_TOKEN_URL = "https://accounts.secure.freee.co.jp/public_api/token";
const SUPABASE_URL = "https://fgbqheodukryhcmrjucn.supabase.co";
const SUPABASE_KEY = "sb_publishable_gGLBPr0f3AqjdvNlgJk5dA_pBQjWfHP";
const SECRET_ROW = "freee_refresh";

async function loadRefreshToken() {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/helm_secrets?id=eq.${SECRET_ROW}&select=value`,
      { headers: { apikey: SUPABASE_KEY } }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return (rows && rows[0] && rows[0].value) || null;
  } catch {
    return null;
  }
}

async function saveRefreshToken(value) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/helm_secrets`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({ id: SECRET_ROW, value, updated_at: new Date().toISOString() }),
    });
  } catch {
    /* 保存できなくても今回の取得は成功しているので握りつぶす */
  }
}

async function accessToken() {
  const stored = await loadRefreshToken();
  const refresh = stored || process.env.FREEE_REFRESH_TOKEN;
  const res = await fetch(FREEE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.FREEE_CLIENT_ID,
      client_secret: process.env.FREEE_CLIENT_SECRET,
      refresh_token: refresh,
    }),
  });
  const body = await res.json();
  if (!body.access_token) throw new Error("token: " + JSON.stringify(body).slice(0, 200));
  if (body.refresh_token && body.refresh_token !== refresh) await saveRefreshToken(body.refresh_token);
  return body.access_token;
}

async function fetchDeals(token, type, from, to, companyId) {
  const out = [];
  for (let offset = 0; offset < 3000; offset += 100) {
    const url = `${FREEE_API}/deals?company_id=${companyId}&type=${type}` +
      `&start_issue_date=${from}&end_issue_date=${to}&limit=100&offset=${offset}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, accept: "application/json" } });
    if (!r.ok) throw new Error(`${type}: ${(await r.text()).slice(0, 200)}`);
    const ds = ((await r.json()) || {}).deals || [];
    out.push(...ds);
    if (ds.length < 100) break;
  }
  return out;
}

function sumByMonth(deals) {
  const m = {};
  for (const d of deals) {
    const k = String(d.issue_date || "").slice(0, 7);
    if (!k) continue;
    m[k] = (m[k] || 0) + (Number(d.amount) || 0);
  }
  return m;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");
  try {
    if ((req.query.t || "") !== process.env.HELM_TOKEN) {
      return res.status(401).json({ ok: false, error: "bad token" });
    }
    const companyId = process.env.FREEE_COMPANY_ID || "80198";
    const jst = new Date(Date.now() + 9 * 3600 * 1000);
    const year = Number(req.query.year) || jst.getUTCFullYear();
    const token = await accessToken();
    const [inc, exp] = await Promise.all([
      fetchDeals(token, "income", `${year}-01-01`, `${year}-12-31`, companyId),
      fetchDeals(token, "expense", `${year}-01-01`, `${year}-12-31`, companyId),
    ]);
    const I = sumByMonth(inc), E = sumByMonth(exp);
    const months = [];
    for (let i = 1; i <= 12; i++) {
      const key = `${year}-${String(i).padStart(2, "0")}`;
      const a = I[key] || 0, b = E[key] || 0;
      if (!a && !b) continue;
      months.push({ month: key, income: a, expense: b, net: a - b });
    }
    const cur = `${year}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}`;
    const current = months.find((x) => x.month === cur) || { month: cur, income: 0, expense: 0, net: 0 };
    const ytd = months.reduce(
      (s, x) => ({ income: s.income + x.income, expense: s.expense + x.expense, net: s.net + x.net }),
      { income: 0, expense: 0, net: 0 }
    );
    return res.status(200).json({ ok: true, year, current, ytd, months, fetchedAt: new Date().toISOString() });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
