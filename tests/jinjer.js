// jinjerクライアントの確認(429のやり直し・リクエスト間隔)。模擬のjinjerサーバー(127.0.0.1)に対して実行し、外部には接続しない
'use strict';
const http = require('http');
const path = require('path');
const { ROOT, makeChecker } = require('./lib/harness');
const { check, done } = makeChecker('jinjer');

(async () => {
  // 模擬サーバー: /v2/token は常に成功。/data は、mode に応じて 429 を返す
  const log = []; // { path, at }
  let remain429 = 0, retryAfter = null;
  const server = http.createServer((req, res) => {
    log.push({ path: req.url, at: Date.now() });
    if (req.url.startsWith('/v2/token')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: { access_token: 'dummy-token' } })); }
    if (remain429 > 0) {
      remain429--;
      res.statusCode = 429;
      if (retryAfter != null) res.setHeader('Retry-After', String(retryAfter));
      res.setHeader('X-RateLimit-Remaining', '0');
      return res.end('too many');
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  process.env.JINJER_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.JINJER_API_KEY = 'dummy'; process.env.JINJER_SECRET_KEY = 'dummy';
  const client = require(path.join(ROOT, 'src', 'jinjerClient.js'));
  const warn = console.warn; const warnings = []; console.warn = (...a) => warnings.push(a.join(' ')); // 想定した警告ログを取り出す

  try {
    // 待ち時間を短くして確認する
    Object.assign(client.tuning, { minGapMs: 50, retryMax: 3, backoffBaseMs: 40, retryAfterCapMs: 2000 });
    const dataCalls = () => log.filter(l => l.path.startsWith('/data'));

    // 1) 429が2回続いたあと成功 → やり直して成功する
    log.length = 0; remain429 = 2; retryAfter = null;
    const r1 = await client.authedFetch('/data?x=1');
    check('429が2回続いても、待ってやり直して成功する', r1.ok && dataCalls().length === 3, `calls=${dataCalls().length}`);
    { const d = dataCalls(); check('429のたびに待ち時間が段階的に長くなる(40ms→80ms)', d[1].at - d[0].at >= 35 && d[2].at - d[1].at >= 75, d.map((x, i) => i ? x.at - d[i - 1].at : 0).join('/')); }
    check('429のとき、上限の手がかり(ヘッダー)をログに残す', warnings.some(w => w.includes('429') && w.includes('x-ratelimit-remaining=0')), warnings.join(' | ').slice(0, 200));
    check('ログにトークン・キーを含めない', !warnings.join(' ').includes('dummy'));

    // 2) Retry-After(秒)に従う
    log.length = 0; remain429 = 1; retryAfter = 0.3; warnings.length = 0;
    await client.authedFetch('/data');
    const d2 = dataCalls();
    check('Retry-Afterの待ち時間に従う(0.3秒)', d2.length === 2 && d2[1].at - d2[0].at >= 280 && d2[1].at - d2[0].at < 1500, String(d2.length && d2[d2.length - 1].at - d2[0].at));

    // 3) 429が続く → 上限回数(retryMax=3 → 計4回)で失敗する(無限に待たない)
    log.length = 0; remain429 = 99; retryAfter = null;
    let err = null; try { await client.authedFetch('/data'); } catch (e) { err = e; }
    check('429が続く場合は、上限回数までで失敗する(status=429)', err && err.status === 429 && dataCalls().length === 4, `calls=${dataCalls().length}`);

    remain429 = 0;
    // 4) 全体の制限時間(signal)で、待ち中も中断できる
    log.length = 0; remain429 = 99; retryAfter = 5;
    const ac = AbortSignal.timeout(300);
    const t0 = Date.now(); err = null;
    try { await client.authedFetch('/data', { signal: ac }); } catch (e) { err = e; }
    check('全体の制限時間が来たら、待ち中でも中断する', !!err && Date.now() - t0 < 2000, `elapsed=${Date.now() - t0}`);

    // 5) リクエスト間隔: 同時に呼んでも minGapMs 以上あく
    remain429 = 0; retryAfter = null; log.length = 0; client.tuning.minGapMs = 150;
    await Promise.all([1, 2, 3, 4].map(i => client.authedFetch('/data?i=' + i)));
    const ds = dataCalls().map(l => l.at).sort((a, b) => a - b);
    const minGap = Math.min(...ds.slice(1).map((t, i) => t - ds[i]));
    check('同時に呼んでも、リクエストの間隔を最低限あける', ds.length === 4 && minGap >= 130, `minGap=${minGap}`);

    // 6) 退勤時刻がまだ来ていない人は、出勤中として返す(退勤の予定をjinjerに先に登録した場合。2026-10-19・ユーザー指示)
    const { DatabaseSync } = require('node:sqlite');
    const att = require(path.join(ROOT, 'src', 'jinjerAttendance.js'));
    const mem = new DatabaseSync(':memory:'); // 実際のDBには触らない
    mem.exec("CREATE TABLE attendance_today (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, employee_id TEXT, email TEXT, name TEXT, attended TEXT, left_at TEXT DEFAULT '', synced_at TEXT);" +
      'CREATE TABLE attendance_sync (id INTEGER PRIMARY KEY, target_date TEXT, ok INTEGER, message TEXT, run_at TEXT, ok_date TEXT);');
    const ins = mem.prepare('INSERT INTO attendance_today (date, employee_id, email, name, attended, left_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const now = new Date('2026-10-19T04:45:00Z'); // 日本時間 13:45
    ins.run('2026-10-19', '1', 'a@x.com', 'A', '09:00', '17:30', '');  // 退勤予定(まだ来ていない)
    ins.run('2026-10-19', '2', 'b@x.com', 'B', '09:00', '12:00', '');  // 退勤済み
    ins.run('2026-10-19', '3', 'c@x.com', 'C', '09:00', '13:45', '');  // ちょうど今=退勤済み
    ins.run('2026-10-19', '4', 'd@x.com', 'D', '09:00', '', '');       // 退勤の打刻なし=出勤中
    const g = att.getToday(mem, now);
    const left = Object.fromEntries(g.items.map(i => [i.name, i.left_at]));
    check('退勤予定(17:30)が未来なら、13:45時点では出勤中として返す', left.A === '', JSON.stringify(left));
    check('退勤時刻が過去・現在なら、退勤済みのまま', left.B === '12:00' && left.C === '13:45', JSON.stringify(left));
    check('退勤の打刻がない人は出勤中のまま', left.D === '');
    const g2 = att.getToday(mem, new Date('2026-10-19T08:31:00Z')); // 日本時間 17:31
    check('17:31になれば、取り込みを待たずに退勤済みで返す', g2.items.find(i => i.name === 'A').left_at === '17:30');
    check('isFutureTime: 読めない値・空は未来扱いしない', att.isFutureTime('', { hour: 13, minute: 45 }) === false && att.isFutureTime('abc', { hour: 13, minute: 45 }) === false);
    check('他の日の行は出さない(翌日の日付では空)', att.getToday(mem, new Date('2026-10-20T04:45:00Z')).items.length === 0);
  } finally {
    console.warn = warn;
    server.close();
  }
  process.exit(done() ? 1 : 0);
})().catch(e => { console.error('TEST ERROR', e); process.exit(2); });
