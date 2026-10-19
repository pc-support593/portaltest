// jinjer API の共通部分(トークン取得・API呼び出し・日本時間)。休日休暇(jinjerDayOffs.js)と出勤状況(jinjerAttendance.js)が共用する。
// APIキー/シークレットはサーバーの環境変数 JINJER_API_KEY / JINJER_SECRET_KEY にだけ置く(コード・public/・GitHubに書かない)。
'use strict';

const BASE = process.env.JINJER_BASE_URL || 'https://api.jinjer.biz'; // JINJER_BASE_URL はテスト(模擬サーバー)用。本番では設定しない
const REQUEST_TIMEOUT_MS = 30_000;
const TOKEN_TTL_MS = 3 * 60 * 60 * 1000; // アクセストークンの有効期限は4時間。余裕を持って3時間で取り直す

// 429(短時間に呼びすぎ)対策(2026-10-19・ユーザー指示): ①jinjerへのリクエストの間隔を最低 minGapMs あける(続けて呼ばない)
// ②429が返ったら、jinjerが示す待ち時間(Retry-After)か、無ければ段階的に長くした待ち時間で、retryMax 回までやり直す
// ③429のときは、上限値の手がかりとして、応答ヘッダーの待ち時間・上限に関する項目をログに残す(キー・トークンは含めない)
const tuning = { minGapMs: 500, retryMax: 3, backoffBaseMs: 2000, retryAfterCapMs: 30_000 }; // テストで小さい値に変えられるよう公開している

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

let lastRequestAt = 0;
let gate = Promise.resolve(); // リクエストを1本ずつ順番に並べる(同時に走っても間隔を守る)

/** signal(全体の制限時間)に反応するsleep */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(signal.reason || new Error('中断されました'));
    const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason || new Error('中断されました')); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 前のリクエストから minGapMs あける。順番待ちの列(gate)に並べて、同時呼び出しでも間隔を守る */
function paced(signal) {
  const turn = gate.then(async () => {
    const wait = lastRequestAt + tuning.minGapMs - Date.now();
    if (wait > 0) await sleep(wait, signal);
    lastRequestAt = Date.now();
  });
  gate = turn.catch(() => {}); // 1つの中断が、後続を止めないようにする
  return turn;
}

async function jinjerFetch(path, { headers = {}, signal } = {}) {
  await paced(signal);
  // 1回のリクエストの上限(30秒)に加え、呼び出し元の全体の制限時間(signal)でも中断する
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetch(BASE + path, { headers, signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
  if (!res.ok) {
    // 応答本文にはキー等を含めない(ステータスのみ記録)
    const err = new Error(`jinjer APIエラー (HTTP ${res.status}) ${path.split('?')[0]}`);
    err.status = res.status;
    if (res.status === 429) {
      const raw = res.headers.get('Retry-After'); // 無いときは null(Number(null) は 0 になるため、先に有無を見る)
      const ra = raw == null || raw === '' ? NaN : Number(raw);
      err.retryAfterMs = Number.isFinite(ra) && ra >= 0 ? ra * 1000 : null;
      const hints = [];
      res.headers.forEach((v, k) => { if (/retry|rate|limit|remaining|reset/i.test(k)) hints.push(`${k}=${v}`); });
      console.warn(`jinjer 429(呼びすぎ): ${path.split('?')[0]} ヘッダー: ${hints.join(', ') || '(待ち時間・上限の情報なし)'}`);
    }
    throw err;
  }
  return res;
}

/** アクセストークン。有効期間内は使い回す(10分おきの取り込みで、毎回トークンを取り直してAPI上限を消費しないため)。発行中は同じPromiseを共有する */
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

/** 429のときだけ、待ってやり直す(最大 retryMax 回)。待ち時間はjinjerの指示(Retry-After。上限 retryAfterCapMs)か、無ければ 2秒・4秒・8秒… */
async function withRetry429(fn, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e.status !== 429 || attempt >= tuning.retryMax) throw e;
      const wait = Math.min(e.retryAfterMs != null ? e.retryAfterMs : tuning.backoffBaseMs * 2 ** attempt, tuning.retryAfterCapMs);
      console.warn(`jinjer 429のため ${Math.round(wait / 1000 * 10) / 10}秒待ってやり直します(${attempt + 1}/${tuning.retryMax}回目)`);
      await sleep(wait, signal);
    }
  }
}

/** 認証付きGET。401ならトークンを取り直して1回だけやり直す(キャッシュ済みトークンが無効になった場合の保険)。429は待ってやり直す */
async function authedFetch(path, { signal } = {}) {
  return withRetry429(async () => {
    let token = await getToken({ signal });
    try {
      return await jinjerFetch(path, { headers: { Authorization: `Bearer ${token}` }, signal });
    } catch (e) {
      if (e.status !== 401) throw e;
      token = await getToken({ fresh: true, signal });
      return jinjerFetch(path, { headers: { Authorization: `Bearer ${token}` }, signal });
    }
  }, signal);
}

module.exports = { tuning, BASE, jstNow, isConfigured, jinjerFetch, getToken, authedFetch };
