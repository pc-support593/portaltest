// 画面側の計算ロジックの確認(common.js・schedule.js の純粋な関数)。ブラウザなしで実行できる
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT, makeChecker } = require('./lib/harness');
const { check, done } = makeChecker('unit');

/** 画面のJS(グローバル関数をそのまま定義する形式)を、最小限のダミー環境で読み込み、指定した名前を取り出す */
function load(files, names) {
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, Promise, Date, Intl,
    window: { addEventListener() {} },
    document: { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null },
    state: { date: new Date(2026, 9, 17) }, Auth: { init: () => new Promise(() => {}) }, // ページ起動処理(Auth.init)は進めない
    isoDate: d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  });
  for (const file of [].concat(files)) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', file), 'utf8'), ctx, { filename: file }); // const/let は同じ文脈の次のスクリプトから見える
  }
  // const/let はスクリプトの外から見えないので、最後に globalThis へ書き出して取り出す
  vm.runInContext(names.map(n => `try{globalThis.${n}=${n}}catch(e){}`).join(';'), ctx);
  return ctx;
}

const c = load(['common.js'], ['displayName', 'fullNameOf', 'jstDateKey', 'isBeforeHireDate', 'employeeTypeRank', 'compareMembersByRank', 'sortKeyFromEmail', 'compareRomajiGojuon', 'withTimeout', 'surname', 'esc', 'phoneListOf', 'searchPortalPages']);

// 名前
check('displayName: 会社名の括弧書きを除く(全角)', c.displayName('本田 悠(吉村一建設)') === '本田 悠');
check('displayName: 会社名の括弧書きを除く(半角)', c.displayName('本田 悠 (ゆめすみか)') === '本田 悠');
check('displayName: 該当しない名前は変えない', c.displayName('山田  太郎(営業)') === '山田  太郎(営業)');
check('displayName: 括弧書きだけなら元のまま', c.displayName('(吉村一建設)') === '(吉村一建設)');
check('fullNameOf: 姓 名(半角スペース1つ)', c.fullNameOf('本田', '悠', 'x') === '本田 悠');
check('fullNameOf: 姓か名が空なら表示名', c.fullNameOf('本田', '', '本田 悠(吉村一建設)') === '本田 悠');
check('fullNameOf: 前後の空白を除く', c.fullNameOf(' 本田 ', ' 悠 ', 'x') === '本田 悠');
check('surname: 全角スペース区切り', c.surname('本田　悠') === '本田');
check('esc: HTMLエスケープ', c.esc('<a href="x">&') === '&lt;a href=&quot;x&quot;&gt;&amp;');
check('phoneListOf: 携帯+事業所(空は除く)', JSON.stringify(c.phoneListOf({ mobilePhone: '090', businessPhones: ['03', ''] })) === '["090","03"]');

// 入社日(日本時間の暦で判定)
const now = new Date();
const dayMs = 86400000;
const key = d => c.jstDateKey(d);
check('入社日: 空は表示する(非表示にしない)', c.isBeforeHireDate('') === false && c.isBeforeHireDate(null) === false);
check('入社日: 読めない日付は表示する', c.isBeforeHireDate('abc') === false);
check('入社日: 入社日当日から表示する', c.isBeforeHireDate(key(now) + 'T00:00:00Z') === false);
check('入社日: 明日入社はまだ非表示', c.isBeforeHireDate(key(new Date(now.getTime() + dayMs)) + 'T00:00:00Z') === true);
check('入社日: 昨日入社は表示', c.isBeforeHireDate(key(new Date(now.getTime() - dayMs)) + 'T00:00:00Z') === false);
check('jstDateKey: UTC 15:00 は日本の翌日', c.jstDateKey(new Date('2026-10-16T15:00:00Z')) === '2026-10-17');

// 検索: 機能が無効な環境では「出勤状況」を候補に出さない(整理案F)
check('検索: キー未設定の環境では出勤状況が出ない', !c.searchPortalPages('出勤状況').some(p => p.url === 'attendance.html') && c.searchPortalPages('出勤').some(p => p.url === 'today-attendance.html'));
c.Auth.config = { features: { attendance: true } };
check('検索: 有効な環境では出勤状況が出る', c.searchPortalPages('出勤状況').some(p => p.url === 'attendance.html'));

// 並び順
check('rank: 2以降は数字、1・空・非数字は順位なし', c.employeeTypeRank('2') === 2 && c.employeeTypeRank('10') === 10 && c.employeeTypeRank('1') === Infinity && c.employeeTypeRank('') === Infinity && c.employeeTypeRank('部長') === Infinity);
check('sortKey: 最初の「-」より後ろ', c.sortKeyFromEmail('t-tomofuji@yoshimuraichi.com') === 'tomofuji' && c.sortKeyFromEmail('naofumi_kotani@x.com') === 'naofumi_kotani');
const gojuon = ['kotani', 'chiba', 'higashi'].sort(c.compareRomajiGojuon);
check('五十音順: こ < ち < ひ(アルファベット順にならない)', gojuon.join() === 'kotani,chiba,higashi', gojuon.join());
const g2 = ['yamada', 'aoki', 'sato', 'nakamura', 'ishii', 'tanaka', 'kato', 'morimoto', 'wada'].sort(c.compareRomajiGojuon);
check('五十音順: あ→か→さ→た→な→ま→や→わ行', g2.join() === 'aoki,ishii,kato,sato,tanaka,nakamura,morimoto,yamada,wada', g2.join());
const members = [
  { empType: '', email: 'a-aoki@x.com' }, { empType: '3', email: 'z-zeta@x.com' }, { empType: '2', email: 'y-yama@x.com' }, { empType: '', email: 'k-kato@x.com' }
].sort(c.compareMembersByRank).map(m => m.email.split('-')[1].split('@')[0]);
check('メンバー順: 順位の小さい順→順位なしは五十音順', members.join() === 'yama,zeta,aoki,kato', members.join());

(async () => {
  // 時間制限
  let msg = '';
  try { await c.withTimeout(new Promise(r => setTimeout(() => r('late'), 300)), 50, '時間切れ'); } catch (e) { msg = e.message; }
  check('withTimeout: 時間内に終わらなければ失敗(メッセージ付き)', msg === '時間切れ', msg);
  check('withTimeout: 時間内なら結果を返す', await c.withTimeout(Promise.resolve(7), 500) === 7);

  // 週の予定
  const s = load(['roomsData.js', 'schedule.js'], ['weekStartOf', 'weekDatesFrom', 'eventCoversDay']);
  const sun = s.weekStartOf(new Date(2026, 9, 17)); // 土曜
  check('週の始まりは日曜(10/17土 → 10/11日)', sun.getDate() === 11 && sun.getDay() === 0);
  check('週は7日間(日〜土)', s.weekDatesFrom(sun).length === 7 && s.weekDatesFrom(sun)[6].getDay() === 6);
  check('日曜はその日が週の始まり', s.weekStartOf(new Date(2026, 9, 11)).getDate() === 11);
  const day = { date: '2026-10-13', endDate: '2026-10-13', isAllDay: false, start: '10:00', end: '11:00' };
  check('予定: 当日のみ', s.eventCoversDay(day, '2026-10-13') && !s.eventCoversDay(day, '2026-10-12') && !s.eventCoversDay(day, '2026-10-14'));
  const allDay = { date: '2026-10-13', endDate: '2026-10-14', isAllDay: true };
  check('予定: 終日は終了日を含まない(Graphの仕様)', s.eventCoversDay(allDay, '2026-10-13') && !s.eventCoversDay(allDay, '2026-10-14'));
  const multi = { date: '2026-10-13', endDate: '2026-10-15', isAllDay: false, start: '10:00', end: '09:00' };
  check('予定: 複数日にまたがる', s.eventCoversDay(multi, '2026-10-14') && s.eventCoversDay(multi, '2026-10-15') && !s.eventCoversDay(multi, '2026-10-16'));
  const midnight = { date: '2026-10-13', endDate: '2026-10-14', isAllDay: false, start: '20:00', end: '00:00' };
  check('予定: 翌日0時ちょうどに終わる予定は翌日に出さない', s.eventCoversDay(midnight, '2026-10-13') && !s.eventCoversDay(midnight, '2026-10-14'));

  // 社員名簿・出勤状況で共用の部門の組み立て(orgData.js)と、出勤状況の部門分け(attendance.js)
  const o = load(['common.js', 'roomsData.js', 'orgData.js', 'attendance.js'], ['buildGroups', 'splitByCompany', 'buildAttendanceGroups', 'groupsHtml', 'LEFT_GROUP_ORDER']);
  const u = (email, name, empType = '', title = '') => ({ name, email, dept: '', title, empType, phone: '' });
  const people = [u('t-zeta@yoshimuraichi.com', 'ゼータ', '3'), u('a-aoki@yoshimuraichi.com', 'アオキ'), u('y-yama@yoshimuraichi.com', 'ヤマ', '2'), u('c-chief@yoshimuraichi.com', '会長さん', '1', '会長')];
  const depts = { 't-zeta@yoshimuraichi.com': ['営業部', '総務部'], 'a-aoki@yoshimuraichi.com': ['営業部'], 'y-yama@yoshimuraichi.com': ['営業部'] };
  const gs = o.buildGroups(people, ['会長', '社長'], { deptsOf: x => depts[x.email] || [], deptOrder: ['営業部', '総務部'] });
  check('buildGroups: 従業員の種類1は役職が見出しで先頭', gs[0].dept === '会長' && gs[0].members.length === 1, JSON.stringify(gs.map(g => g.dept)));
  check('buildGroups: 部門内は種類の数字の小さい順→五十音順', gs[1].members.map(m => m.name).join() === 'ヤマ,ゼータ,アオキ', gs[1].members.map(m => m.name).join());
  check('buildGroups: 複数部門の人は両方に出る', gs[2].dept === '総務部' && gs[2].members[0].name === 'ゼータ');
  check('LEFT_GROUP_ORDER: 総務部が一番下', o.LEFT_GROUP_ORDER[o.LEFT_GROUP_ORDER.length - 1] === '総務部');
  const sp = o.splitByCompany([u('x@yumesumika.com', 'ゆめ'), u('y@yoshimuraichi.com', '吉村'), u('n-morishita@yoshimuraichi.com', '森下'), u('s-tada@yumesumika.com', '多田')]);
  check('splitByCompany: ドメインで左右(個別指定が優先)', sp.right.map(x => x.name).join() === 'ゆめ,森下' && sp.left.map(x => x.name).join() === '吉村,多田', JSON.stringify(sp));

  const it = (email, name, left_at = '') => ({ email, name, left_at, attended: '09:00' });
  const orgLeft = [{ dept: '営業部', members: [{ email: 'a-aoki@x.com', name: 'アオキ 一' }, { email: 'b-bb@x.com', name: 'ビー 二' }] }, { dept: '総務部', members: [{ email: 'a-aoki@x.com', name: 'アオキ 一' }, { email: 'c-cc@x.com', name: 'シー 三' }, { email: '', name: '手動 追加' }] }];
  const items = [it('c-cc@x.com', 'jinjerシー', '18:00'), it('a-aoki@x.com', 'jinjerアオキ'), it('d-dd@x.com', 'jinjerディー'), it('', '台帳なし')];
  const ag = o.buildAttendanceGroups(orgLeft, items, { 'd-dd@x.com': 'ディー 四' });
  check('出勤状況: 社員名簿の部門・順で、出勤している人だけ', ag.map(g => g.dept + ':' + g.rows.map(r => r.name).join('/')).join(' | ') === '営業部:アオキ 一 | 総務部:アオキ 一/シー 三 | その他:ディー 四/台帳なし', ag.map(g => g.dept + ':' + g.rows.map(r => r.name).join('/')).join(' | '));
  check('出勤状況: 出勤者のいない部門は出さない', !ag.some(g => g.dept === ''));
  check('出勤状況: 手動追加(メールなし)の人は出勤データに出ない', !JSON.stringify(ag).includes('手動'));
  const flat = o.buildAttendanceGroups(null, items, null);
  check('出勤状況: 部門情報がないときは見出しなしの1グループ', flat.length === 1 && flat[0].dept === '' && flat[0].rows.length === 4);
  const html = o.groupsHtml(ag);
  check('出勤状況: 描画に部門見出し(その他は末尾)', html.indexOf('営業部') < html.indexOf('総務部') && html.indexOf('総務部') < html.indexOf('その他'));
  check('出勤状況: 退勤済みは退勤時刻を出す', html.includes('退勤 18:00'));
  check('出勤状況: 出勤者なしのメッセージ', o.groupsHtml([]).includes('該当する方はいません'));
  // メールアドレスを持たない手動追加メンバー(物流事業係の2名)は、氏名で出勤データと突き合わせる
  const orgManual = [{ dept: '物流事業係', members: [{ email: '', name: '松岡 謙次' }, { email: '', name: '荒井 正義' }] }];
  const manualItems = [it('', '荒井　正義'), it('', '松岡謙次', '17:00'), it('', '別 人'), it('x@x.com', '荒井 正義')];
  const mg = o.buildAttendanceGroups(orgManual, manualItems, {});
  const mtxt = mg.map(g => g.dept + ':' + g.rows.map(r => r.name).join('/')).join(' | ');
  check('メールなしの手動メンバーは、氏名で「物流事業係」に出る(空白の違いは無視)', mtxt === '物流事業係:松岡 謙次/荒井 正義 | その他:荒井 正義/別 人', mtxt);
  check('メールなしの名簿メンバーに、メールありの同姓同名は紐づけない', !mg[0].rows.some(r => r.it.email === 'x@x.com'));

  // 年間カレンダー: shift_holiday は文字枠(ラベル)を赤で表示し、日付枠は色を付けない
  const w = load(['common.js', 'workCalendar.js'], ['dayLabelsHtml']);
  const sh = w.dayLabelsHtml([{ type: 'shift_holiday', team: '', label: '創立記念日' }]);
  check('shift_holiday: 文字枠が赤(背景#d64545・白文字)', sh.includes('background:#d64545') && sh.includes('color:#ffffff') && sh.includes('創立記念日'), sh.slice(0, 160));
  check('shift_holiday: 班があれば「A班 …」', w.dayLabelsHtml([{ type: 'shift_holiday', team: 'A', label: '特別休' }]).includes('A班 特別休'));
  check('shift_holiday: labelが空なら「休日」', w.dayLabelsHtml([{ type: 'shift_holiday', team: '', label: '' }]).includes('>休日<'));
  check('shift_holiday: 他の種類(祝日)の見た目は変わらない', !w.dayLabelsHtml([{ type: 'holiday', team: '', label: '祝日' }]).includes('#d64545'));
  process.exit(done() ? 1 : 0);
})().catch(e => { console.error('TEST ERROR', e); process.exit(2); });
