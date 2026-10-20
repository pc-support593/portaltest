// 共通の小道具: チェック集計・隔離サーバー(本物の data/portal.db には触らない)・Edge(CDP)操作
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

function makeChecker(label) {
  let pass = 0, fail = 0;
  const check = (name, ok, extra = '') => {
    (ok ? pass++ : fail++);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? '  -> ' + extra : ''}`);
  };
  const done = () => { console.log(`\n[${label}] ${pass} passed, ${fail} failed`); return fail; };
  return { check, done };
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

/** アプリ(server.js・src・public)を一時フォルダへコピーし、devモード・空のDBで起動する。
    db.js は __dirname 基準で data/ を作るので、コピー先なら実際の data/portal.db は使われない */
async function startSandbox(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-test-'));
  for (const f of ['server.js', 'package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(dir, 'public'), { recursive: true });
  // ESMの import()(unpdf)は NODE_PATH を見ないため、node_modules をコピー先から見えるようにする(本番と同じ配置)
  try { fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'junction'); } catch { /* 作れなければ NODE_PATH だけ */ }
  const port = await freePort();
  // 外部連携のキー・スイッチ(jinjer・iGrace・テナント・休暇取込)は引き継がない。誤って本番のシェルで実行しても、外部へ接続しない
  const env = { ...process.env, PORT: String(port), AUTH_MODE: 'dev', SEED_SAMPLE_DATA: 'false', NODE_PATH: path.join(ROOT, 'node_modules') };
  for (const k of Object.keys(env)) if (/^(JINJER_|IGRACE_|TENANT_ID$|CLIENT_ID$|ENABLE_DAYOFFS$)/.test(k)) delete env[k];
  Object.assign(env, extraEnv); // 機能の有効化の確認用(例: ダミーのJINJERキー)
  env.JINJER_BASE_URL = 'http://127.0.0.1:9'; // 万一キーが残っても到達しない宛先
  const proc = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', d => { stderr += d; });
  let exited = false;
  const exitP = new Promise(r => proc.once('exit', () => { exited = true; r(); }));
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 60 && !up && !exited; i++) {
    try { up = (await fetch(base + '/api/config')).ok; } catch { /* 起動待ち */ }
    if (!up) await new Promise(r => setTimeout(r, 250));
  }
  if (!up) { try { proc.kill(); } catch { /* */ } throw new Error('テスト用サーバーが起動しませんでした: ' + stderr.slice(0, 500)); }
  /** 添付の保存先(data/ 配下のサブフォルダ) */
  const uploads = () => {
    const d = path.join(dir, 'data');
    const found = fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).find(e => e.isDirectory()) : null;
    return found ? path.join(d, found.name) : null;
  };
  /** サーバーを止め、一時フォルダを消す(終了を待ってから消す。呼び出し側は await する) */
  const stop = async () => {
    try { proc.kill(); } catch { /* 既に終了 */ }
    await Promise.race([exitP, sleep(3000)]);
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 使用中は残す */ }
  };
  return { base, dir, uploads, stop };
}

function findEdge() {
  const c = [process.env.EDGE_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
  return c.find(p => fs.existsSync(p)) || null;
}

const httpGet = u => new Promise((res, rej) => http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Edge(headless=new)を起動し、操作用のオブジェクトを返す */
async function launchEdge(edge) {
  const port = await freePort();
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-edge-'));
  const proc = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--user-data-dir=' + ud, '--remote-debugging-port=' + port, 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = JSON.parse(await httpGet(`http://127.0.0.1:${port}/json`)).find(t => t.type === 'page'); } catch { /* 起動待ち */ }
    if (!target) await sleep(250);
  }
  if (!target) { proc.kill(); throw new Error('Edgeに接続できませんでした'); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const pend = new Map();
  ws.onmessage = m => { const j = JSON.parse(m.data); if (j.id && pend.has(j.id)) { pend.get(j.id)(j); pend.delete(j.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable');
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error((r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description) || 'evaluate失敗');
    return r.result && r.result.result && r.result.result.value;
  };
  /** 指定幅でページを開き、条件式が真になるまで待つ(最大 timeout ms)。既定は「ログイン確認が済んで表示された」 */
  const open = async (url, w, h = 900, readyExpr = null, timeout = 15000) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
    await send('Page.navigate', { url });
    const t0 = Date.now();
    await sleep(400);
    while (Date.now() - t0 < timeout) {
      try {
        const ok = await evaluate(readyExpr || "document.readyState === 'complete' && !document.documentElement.classList.contains('auth-pending')");
        if (ok) return true;
      } catch { /* 遷移中 */ }
      await sleep(250);
    }
    return false;
  };
  /** 以降のページ読み込みの先頭で実行するスクリプト(通信の失敗・無応答の再現用)。null で解除 */
  let preId = null;
  const setPreScript = async src => {
    if (preId) { await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: preId }); preId = null; }
    if (src) preId = (await send('Page.addScriptToEvaluateOnNewDocument', { source: src })).result.identifier;
  };
  const close = async () => {
    try { ws.close(); } catch { /* */ }
    const exited = new Promise(r => proc.once('exit', r));
    try { proc.kill(); } catch { /* */ }
    await Promise.race([exited, sleep(3000)]);
    try { fs.rmSync(ud, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 使用中は残す */ }
  };
  return { open, evaluate, setPreScript, close };
}

module.exports = { ROOT, makeChecker, startSandbox, findEdge, launchEdge, sleep };
