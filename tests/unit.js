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

const c = load(['common.js'], ['displayName', 'fullNameOf', 'jstDateKey', 'isBeforeHireDate', 'employeeTypeRank', 'compareMembersByRank', 'sortKeyFromEmail', 'compareRomajiGojuon', 'withTimeout', 'surname', 'esc', 'phoneListOf']);

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
  process.exit(done() ? 1 : 0);
})().catch(e => { console.error('TEST ERROR', e); process.exit(2); });
