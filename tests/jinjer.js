// jinjerクライアントの確認(429のやり直し・リクエスト間隔)。模擬のjinjerサーバー(127.0.0.1)に対して実行し、外部には接続しない
'use strict';
const http = require('http');
const path = require('path');
const { ROOT, makeChecker } = require('./lib/harness');
const { check, done } = makeChecker('jinjer');

(async () => {
  // 模擬サーバー: /v2/token は常に成功。/data は、mode に応じて 429 を返す
  const log = []; // { path, at }
  let remain429 = 0, retryAfter = null, mode400 = null, plain400 = false, fixtures = null; // fixtures: { パスの先頭: { total, data } } を返す(休み取り込みの確認用)。 // mode400: 400で返すエラーコード(null=返さない)。plain400: JSONでない本文で返す
  const server = http.createServer((req, res) => {
    log.push({ path: req.url, at: Date.now() });
    if (req.url.startsWith('/v2/token')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: { access_token: 'dummy-token' } })); }
    if (fixtures) {
      const key = Object.keys(fixtures).find(k => req.url.startsWith(k));
      if (key) { res.statusCode = fixtures[key].status || 200; res.setHeader('content-type', 'application/json'); res.setHeader('X-Item-Counts', String(fixtures[key].total)); return res.end(JSON.stringify({ data: /page=([2-9]|[1-9][0-9])/.test(req.url) ? [] : fixtures[key].data })); }
    }
    if (mode400 && plain400 && req.url.startsWith('/v2/employees/')) { res.statusCode = 400; return res.end('Bad Request <html>'); }
    if (mode400 && req.url.startsWith('/v2/employees/')) { res.statusCode = 400; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ results: 'failure', errors: [{ code: mode400, reason: 'Invalid query parameter.' }] })); }
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
    check('isFutureTime: 読めない値・空は未来扱いしない', att.isFutureTime('', { hour: 13, minute: 45 }) === false && att.isFutureTime('abc', { hour: 13, minute: 45 }) === false && att.isFutureTime('25:00', { hour: 13, minute: 45 }) === false && att.isFutureTime('17:75', { hour: 13, minute: 45 }) === false);
    check('他の日の行は出さない(翌日の日付では空)', att.getToday(mem, new Date('2026-10-20T04:45:00Z')).items.length === 0);
    // 7) 月の切り替え待ち(2026-11-01): jinjerが「月が未来」(E400QP0017)で400を返したら、失敗ではなく切り替え待ちとして記録・表示する
    mode400 = 'E400QP0017';
    let e400 = null; try { await client.authedFetch('/v2/employees/attendances?month=2026-11&page=1'); } catch (e) { e400 = e; }
    check('400のときは、エラーコードだけを取り出す(本文は持たない)', !!e400 && e400.status === 400 && e400.code === 'E400QP0017' && !String(e400.message).includes('Invalid'), e400 && e400.message);
    mem.exec('DELETE FROM attendance_today; DELETE FROM attendance_sync');
    const todayJst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // 日本時間の今日(sync が対象にする日)
    ins.run(todayJst, '9', 'z@x.com', 'Z', '09:00', '', '');
    mem.prepare('INSERT INTO attendance_sync (id, target_date, ok, message, run_at, ok_date) VALUES (1, ?, 1, ?, ?, ?)').run(todayJst, '', 'earlier', todayJst); // 事前に成功していた記録
    const w = await att.sync(mem);
    check('月の切り替え待ち: 取り込みは失敗扱い(ok=false)で、切り替え待ちの文を返す', w.ok === false && w.message === 'jinjerの月の切り替え待ちです。9時以降に更新されます', JSON.stringify(w));
    const gw = att.getToday(mem, new Date());
    check('月の切り替え待ち: 画面用の状態に waiting=true と文が入る', gw.sync && gw.sync.ok === false && gw.sync.waiting === true && gw.sync.message === w.message, JSON.stringify(gw.sync));
    const kept = mem.prepare('SELECT COUNT(*) AS n FROM attendance_today WHERE date = ?').get(todayJst).n;
    const okDate = mem.prepare('SELECT ok_date FROM attendance_sync WHERE id = 1').get().ok_date;
    check('月の切り替え待ちでも、取り込み済みの今日の行と、前回成功した日(ok_date)は残る', kept === 1 && okDate === todayJst, `kept=${kept} ok_date=${okDate}`);
    plain400 = true; let ep = null; try { await client.authedFetch('/v2/employees/attendances?month=2026-11&page=1'); } catch (e) { ep = e; }
    check('JSONでない400の本文でも、通常の400エラーになる(コードなし・例外で落ちない)', !!ep && ep.status === 400 && ep.code === undefined, ep && ep.message);
    plain400 = false;
    mode400 = 'E400QP9999';
    const w2 = await att.sync(mem);
    const gw2 = att.getToday(mem, new Date());
    check('ほかの400は、切り替え待ちにしない(エラーとして出す。waiting=false)', w2.ok === false && w2.message.includes('HTTP 400') && gw2.sync.waiting === false, JSON.stringify(w2));
    mode400 = null;

    // 8) 休みの取り込み(2026-11-02): 休暇(requested-day-offs)と勤務予定(work-schedules)から、今日の休みを求める
    const offs = require(path.join(ROOT, 'src', 'jinjerOffs.js'));
    const today = client.jstNow().date;
    const other = today.slice(0, 8) + (today.endsWith('-01') ? '02' : '01'); // 今日ではない日付
    const sched = d => [{ date: d, store: { id: '1', name: 's' }, work_schedule: { start: '9:00:00', end: '18:00:00' } }];
    const leaveFull = { id: '0', name: '全日' };
    const leaveAm = { id: '1', name: '半休', start_time: today + ' 09:00:00', end_time: today + ' 13:00:00' };
    const leaveData = [
      { employee_id: '10', requested_day_offs: [{ date: today, status: '1', day_off_classification: { name: '年次有休' }, duration_classification: leaveFull }] },       // 承認済みの全日
      { employee_id: '11', requested_day_offs: [{ date: today, status: '0', day_off_classification: { name: '振休' }, duration_classification: leaveAm }] },             // 申請中の午前半休
      { employee_id: '12', requested_day_offs: [{ date: today, status: '2', day_off_classification: { name: '年次有休' }, duration_classification: leaveFull }] },       // 否認(出さない)
      { employee_id: '13', requested_day_offs: [{ date: other, status: '1', day_off_classification: { name: '年次有休' }, duration_classification: leaveFull }] }       // 別の日
    ];
    const scheduleData = [
      { employee_id: '10', work_schedules: sched(other) },                 // 休暇が優先(休日にはしない)
      { employee_id: '12', work_schedules: sched(other) },                 // 否認された休暇は無視され、今日の行がないので休日
      { employee_id: '14', work_schedules: sched(today) },                 // 今日の勤務予定あり=出勤予定(出さない)
      { employee_id: '15', work_schedules: sched(other) },                 // 今日の行なし=休日
      { employee_id: '16', work_schedules: [] },                           // 月の勤務予定が1行もない(未作成の可能性)=出さない
      { employee_id: '13', work_schedules: sched(other) }                  // 別の日の休暇のみ+今日の行なし=休日
    ];
    const comp = offs.computeOffs(leaveData, scheduleData, today);
    const cm = Object.fromEntries(comp.map(r => [r.employee_id, r.kind + ':' + r.label + ':' + r.status]));
    check('休みの判定: 全日=休み・半休=午前休(申請中)。否認は休暇にしない', cm['10'] === 'leave:休み:approved' && cm['11'] === 'leave:午前休:pending' && cm['12'] === 'holiday:休み:approved', JSON.stringify(cm));
    check('休みの判定: 勤務予定がない日は休日。今日の勤務予定がある人・月の予定が1行もない人は出さない', cm['15'] === 'holiday:休み:approved' && cm['13'] === 'holiday:休み:approved' && !('14' in cm) && !('16' in cm), JSON.stringify(cm));
    check('休みの判定: 休暇と休日が重なる人は、休暇を優先する', cm['10'].startsWith('leave:') && comp.filter(r => r.employee_id === '10').length === 1);
    // 同じ日に複数の休暇があるとき
    const lv = (id, st, span) => ({ employee_id: id, requested_day_offs: [{ date: today, status: st, day_off_classification: { name: 'x' }, duration_classification: span }] });
    const pm = { id: '1', name: '半休', start_time: today + ' 14:00:00', end_time: today + ' 18:00:00' };
    const multi = offs.computeOffs([
      { employee_id: '20', requested_day_offs: [lv('20', '1', leaveAm).requested_day_offs[0], lv('20', '1', pm).requested_day_offs[0]] },   // 午前休+午後休(承認済み)
      { employee_id: '21', requested_day_offs: [lv('21', '0', leaveFull).requested_day_offs[0], lv('21', '1', leaveAm).requested_day_offs[0]] }, // 全日(申請中)+午前休(承認済み)
      { employee_id: '22', requested_day_offs: [lv('22', '1', leaveAm).requested_day_offs[0], lv('22', '0', pm).requested_day_offs[0]] }    // 午前休(承認済み)+午後休(申請中)
    ], [], today);
    const mm = Object.fromEntries(multi.map(r => [r.employee_id, r.label + ':' + r.status]));
    check('休みの判定: 午前休と午後休が両方あれば「休み」(両方承認済みなら承認済み、どちらかが申請中なら申請中)。全日があれば「休み」', mm['20'] === '休み:pending' || mm['20'] === '休み:approved' ? mm['20'] === '休み:approved' && mm['21'] === '休み:pending' && mm['22'] === '休み:pending' : false, JSON.stringify(mm));
    check('休みのラベル: 半休・時間休・全日', offs.offLabelOf('全日') === '休み' && offs.offLabelOf('午後半休') === '午後休' && offs.offLabelOf('半休') === '半休' && offs.offLabelOf('時間休 10:00-12:00') === '時間休 10:00-12:00' && offs.offLabelOf('') === '休み');

    fixtures = {
      '/v2/employees/requested-day-offs': { total: leaveData.length, data: leaveData },
      '/v2/employees/work-schedules': { total: scheduleData.length, data: scheduleData },
      '/v1/employees': { total: 0, data: ['10', '11', '12', '13', '15'].map(id => ({ id, company: { email: 'U' + id + '@X.com', last_name: '姓' + id, first_name: '名' } })) }
    };
    mem.exec("CREATE TABLE attendance_offs (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, employee_id TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL, synced_at TEXT NOT NULL);" +
      'CREATE TABLE attendance_offs_sync (id INTEGER PRIMARY KEY CHECK (id = 1), target_date TEXT NOT NULL DEFAULT "", ok INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT "", run_at TEXT NOT NULL DEFAULT "", ok_date TEXT NOT NULL DEFAULT "");');
    mem.prepare("INSERT INTO attendance_offs (date, employee_id, email, name, kind, label, status, synced_at) VALUES ('2020-01-01', '99', '', 'old', 'leave', '休み', 'approved', '')").run(); // 古い行は取り込みで消える
    const so = await offs.sync(mem);
    const go = offs.getToday(mem);
    const gm = Object.fromEntries(go.offs.map(r => [r.email, r.kind + ':' + r.label + ':' + r.status]));
    check('休みの取り込み: 成功し、休暇・休日の行を保存する(古い行は消える)。メール・氏名を解決し、メールは小文字', so.ok === true && so.count === 5 && go.offs.length === 5 && gm['u13@x.com'] === 'holiday:休み:approved' && gm['u10@x.com'] === 'leave:休み:approved' && gm['u11@x.com'] === 'leave:午前休:pending' && gm['u12@x.com'] === 'holiday:休み:approved' && gm['u15@x.com'] === 'holiday:休み:approved' && !go.offs.some(r => r.name === 'old'), JSON.stringify(so) + JSON.stringify(gm));
    check('休みの取り込み: 画面用の状態(offsSync)が入り、社員番号は返さない', go.offsSync && go.offsSync.ok === true && go.offsSync.waiting === false && !JSON.stringify(go.offs).includes('employee_id'));
    mode400 = null; fixtures = null; mem.exec('DELETE FROM attendance_offs_sync');
    // 月の切り替え待ち(2026-11-01と同じ)でも例外で落ちず、前回の休みは残る
    mode400 = 'E400QP0017'; fixtures = { '/v1/employees': { total: 0, data: [] } };
    const sw = await offs.sync(mem);
    const gw3 = offs.getToday(mem);
    check('休みの取り込み: 月の切り替え待ちは、切り替え待ちとして記録し、前回の休みは残す', sw.ok === false && sw.message === 'jinjerの月の切り替え待ちです。9時以降に更新されます' && gw3.offsSync.waiting === true && gw3.offs.length === 5, JSON.stringify(sw));
    mode400 = null; fixtures = null;
    // 氏名・メールを解決できなかったときは、取り込みを失敗として扱い、前回の休みを残す(名無しの行で置き換えない)
    const newLeave = [lv('30', '1', leaveFull)]; // 氏名・メールが未キャッシュの社員(キャッシュにあると、問い合わせが起きないため)
    fixtures = {
      '/v2/employees/requested-day-offs': { total: newLeave.length, data: newLeave },
      '/v2/employees/work-schedules': { total: 0, data: [] },
      '/v1/employees': { total: 0, data: [], status: 500 }
    };
    const beforeNames = JSON.stringify(offs.getToday(mem).offs);
    const sf = await offs.sync(mem);
    check('休みの取り込み: 氏名・メールを取得できないときは失敗として扱い、前回の休みは変えない', sf.ok === false && sf.message.includes('社員情報') && JSON.stringify(offs.getToday(mem).offs) === beforeNames, JSON.stringify(sf));
    // 全件取れなかったとき(総数より少ない)も失敗とし、前回の休みを残す
    fixtures = { '/v2/employees/requested-day-offs': { total: 99, data: leaveData }, '/v2/employees/work-schedules': { total: scheduleData.length, data: scheduleData } };
    const sp = await offs.sync(mem);
    check('休みの取り込み: 総数より少ないときは、部分取得を成功扱いにせず、前回の休みは変えない', sp.ok === false && sp.message.includes('全件') && JSON.stringify(offs.getToday(mem).offs) === beforeNames, JSON.stringify(sp));
    fixtures = null;
  } finally {
    console.warn = warn;
    server.close();
  }
  process.exit(done() ? 1 : 0);
})().catch(e => { console.error('TEST ERROR', e); process.exit(2); });
