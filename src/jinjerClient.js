// jinjer API の共通部分(トークン取得・API呼び出し・日本時間)。休日休暇(jinjerDayOffs.js)と出勤状況(jinjerAttendance.js)が共用する。
// APIキー/シークレットはサーバーの環境変数 JINJER_API_KEY / JINJER_SECRET_KEY にだけ置く(コード・public/・GitHubに書かない)。
'use strict';

const BASE = process.env.JINJER_BASE_URL || 'https://api.jinjer.biz'; // JINJER_BASE_URL はテスト(模擬サーバー)用。本番では設定しない
const REQUEST_TIMEOUT_MS = 30_000;
const TOKEN_TTL_MS = 3 * 60 * 60 * 1000; // アクセストークンの有効期限は4時間。余裕を持って3時間で取り直す

let cachedToken = null; // { token, at }
let inflightToken = null; // 発行中のPromise(同時に複数の取り込みが走ってもトークンを二重発行しない)

/** 日本時間の日付(YYYY-MM-DD)と時刻(時)。サーバー(Render=UTC)のタイムゾーンに依存しない */
function jstNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function isConfigured() {
  return Boolean(process.env.JINJER_API_KEY && process.env.JINJER_SECRET_KEY);
}

async function jinjerFetch(path, { headers = {}, signal } = {}) {
  // 1回のリクエストの上限(30秒)に加え、呼び出し元の全体の制限時間(signal)でも中断する
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetch(BASE + path, { headers, signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
  if (!res.ok) {
    // 応答本文にはキー等を含めない(ステータスのみ記録)
    const err = new Error(`jinjer APIエラー (HTTP ${res.status}) ${path.split('?')[0]}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

/** アクセストークン。有効期間内は使い回す(5分おきの取り込みで、毎回トークンを取り直してAPI上限を消費しないため)。発行中は同じPromiseを共有する */
async function getToken({ fresh = false, signal } = {}) {
  if (!fresh && cachedToken && Date.now() - cachedToken.at < TOKEN_TTL_MS) return cachedToken.token;
  if (inflightToken) return inflightToken;
  inflightToken = (async () => {
    const res = await jinjerFetch('/v2/token', {
      headers: { 'X-API-KEY': process.env.JINJER_API_KEY, 'X-SECRET-KEY': process.env.JINJER_SECRET_KEY },
      signal
    });
    const body = await res.json();
    const token = body && body.data && body.data.access_token;
    if (!token) throw new Error('jinjerのアクセストークンを取得できませんでした');
    cachedToken = { token, at: Date.now() };
    return token;
  })().finally(() => { inflightToken = null; });
  return inflightToken;
}

/** 認証付きGET。401ならトークンを取り直して1回だけやり直す(キャッシュ済みトークンが無効になった場合の保険) */
async function authedFetch(path, { signal } = {}) {
  let token = await getToken({ signal });
  try {
    return await jinjerFetch(path, { headers: { Authorization: `Bearer ${token}` }, signal });
  } catch (e) {
    if (e.status !== 401) throw e;
    token = await getToken({ fresh: true, signal });
    return jinjerFetch(path, { headers: { Authorization: `Bearer ${token}` }, signal });
  }
}

module.exports = { BASE, jstNow, isConfigured, jinjerFetch, getToken, authedFetch };
