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

const c = load(['common.js'], ['displayName', 'fullNameOf', 'jstDateKey', 'isBeforeHireDate', 'employeeTypeRank', 'compareMembersByRank', 'sortKeyFromEmail', 'compareRomajiGojuon', 'withTimeout', 'surname', 'esc', 'phoneListOf', 'searchPortalPages', 'isShiftTeamEligible', 'calendarGroupFor']);

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

// 当番表・班の臨時交代の対象: @yoshimuraichi.com と、個別に加えた s-yamanaka@yumesumika.com だけ(他の @yumesumika.com は対象外)
check('当番表の対象: yoshimuraichi.com は対象・s-yamanaka@yumesumika.com も対象(大文字小文字は区別しない)', c.isShiftTeamEligible('a-b@yoshimuraichi.com') && c.isShiftTeamEligible('s-yamanaka@yumesumika.com') && c.isShiftTeamEligible('S-Yamanaka@Yumesumika.com'));
check('当番表の対象: 他の @yumesumika.com の人は対象外', !c.isShiftTeamEligible('k-ohira@yumesumika.com') && !c.isShiftTeamEligible(''));
check('s-yamanaka@yumesumika.com の定休グループは、ドメインの既定(水曜定休)のまま', c.calendarGroupFor('s-yamanaka@yumesumika.com', '') === 'wednesday_off');

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

  // 組織図(orgChart.js): 社員名簿のデータ+手入力の役職から、5階層の枠組みに振り分ける
  const oc = load(['common.js', 'orgChart.js'], ['buildOrgChart', 'ORG_CHART_FRAME', 'orgChartPeopleForAdmin']);
  const P = (name, email, title = '', empType = '') => ({ name, email, title, empType, phone: '' });
  const ocOrg = {
    left: [
      { dept: '会長', members: [P('友藤 昭弘', 'a@x.com', '取締役会長', '1')] }, { dept: '社長', members: [P('友藤 忠昭', 'b@x.com', '代表取締役', '1')] },
      { dept: '専務', members: [P('東 伸考', 'c@x.com', '専務取締役', '1')] },
      { dept: '購買部', members: [P('靍谷 佳憲', 'd@x.com', '取締役部長'), P('次長 太郎', 'e@x.com', '次長'), P('主任 花子', 'f@x.com'), P('課長 一郎', 'g@x.com'), P('一般 次郎', 'h@x.com'), P('', '', '')].slice(0, 5) },
      { dept: '不動産部', members: [P('広沢 成男', 'i@x.com')] },
      { dept: '物流事業係', members: [P('荒井 正義', '')] }, { dept: '工務部(本社)', members: [P('工務 太郎', 'j@x.com', '部長')] }
    ],
    right: [
      { dept: 'ゆめすみか常務取締役', members: [P('森下 直美', 'k@y.com', '常務取締役')] }, { dept: 'マネージャー', members: [P('大平 国弘', 'l@y.com', 'マネージャー')] },
      { dept: '福田展示場', members: [P('店 長', 'm@y.com'), P('平 社員', 'n@y.com')] }
    ],
    names: { 'k@y.com': '森下 直美' }
  };
  const ocManual = [
    { email: 'g@x.com', dept: '', title: '課長', sort: 0 }, { email: 'f@x.com', dept: '', title: '主任', sort: 0 },
    { email: 'k@y.com', dept: '不動産部', title: '次長(兼任)', sort: 0 }, { email: 'name:荒井正義', dept: '', title: '主任', sort: 0 },
    { email: 'm@y.com', dept: '', title: '店長', sort: 0 }, { email: 'd@x.com', dept: '', title: '無視される', sort: 0 }
  ];
  const ch = oc.buildOrgChart(ocOrg, ocManual);
  const colOf = n => ch.columns.find(c => c.name === n);
  check('組織図: ①会長・社長が1つの枠、②専務', ch.l1.map(p => p.name).join() === '友藤 昭弘,友藤 忠昭' && ch.l2.map(p => p.name).join() === '東 伸考');
  check('組織図: 購買部の③は取締役部長(MS365の役職を、手入力の既定より優先)、④は次長', colOf('購買部').l3.map(p => p.name + ':' + p.title).join() === '靍谷 佳憲:取締役部長' && colOf('購買部').l4.map(p => p.name).join() === '次長 太郎');
  check('組織図: ⑤は手入力の役職順(課長→主任→役職なし)', colOf('購買部').sections[0].members.map(m => m.name + ':' + m.title).join() === '課長 一郎:課長,主任 花子:主任,一般 次郎:');
  check('組織図: ゆめすみかは③=常務取締役・④=マネージャー、⑤は店長が先', colOf('㈱ゆめすみか').l3[0].title === '常務取締役' && colOf('㈱ゆめすみか').l4[0].name === '大平 国弘' && colOf('㈱ゆめすみか').sections[0].members.map(m => m.title).join() === '店長,');
  check('組織図: 兼任(手入力で部門を指定)は、MS365のグループに無くても④に載る', colOf('不動産部').l4.map(p => p.name + ':' + p.title).join() === '森下 直美:次長(兼任)');
  check('組織図: メールの無い手動メンバー(荒井 正義)は氏名のキーで手入力の役職が付く', colOf('工務部').sections.find(s => s.label === '物流事業係').members[0].title === '主任');
  check('組織図: 工務部の部長は③に載る', colOf('工務部').l3.map(p => p.name).join() === '工務 太郎');
  // 役職の判定: 「部長代理」などは③に入らない・「店長代理」は「店長」より後ろ・「次長(兼任)」は④
  const ocOrg2 = { left: [{ dept: '総務部', members: [P('部長 本人', 'p1@x.com', '部長'), P('代理 人', 'p2@x.com', '部長代理'), P('次長 兼', 'p3@x.com', '次長(兼任)'), P('マ 補', 'p4@x.com', 'マネージャー補佐')] }], right: [{ dept: '福田展示場', members: [P('代 理', 'q1@y.com', '店長代理'), P('店 長', 'q2@y.com', '店長'), P('係 長', 'q3@y.com', '係長')] }], names: {} };
  const ch2 = oc.buildOrgChart(ocOrg2, []);
  check('組織図: 「部長」「次長(兼任)」は③④・「部長代理」「マネージャー補佐」は⑤に回る', ch2.columns.find(c => c.name === '総務部').l3.map(p => p.name).join() === '部長 本人' && ch2.columns.find(c => c.name === '総務部').l4.map(p => p.name).join() === '次長 兼' && ch2.columns.find(c => c.name === '総務部').sections[0].members.map(p => p.name).join() === '代理 人,マ 補');
  check('組織図: ⑤の順は 店長→係長→店長代理(「店長代理」が「店長」と同じ順位にならない)', ch2.columns.find(c => c.name === '㈱ゆめすみか').sections[0].members.map(m => m.title).join() === '店長,係長,店長代理');

  // ①②は役職の文字で判定する(見出し名が「会長」でなく「取締役会長」、「専務」でなく「専務取締役」でも拾う。部門のグループにいる専務も拾い、部門の列には出さない)
  const ocOrg3 = { left: [
    { dept: '取締役会長', members: [P('友藤 昭弘', 'a@x.com', '取締役会長', '1')] }, { dept: '代表取締役', members: [P('友藤 忠昭', 'b@x.com', '代表取締役', '1')] },
    { dept: '総務部', members: [P('東 伸考', 'c@x.com', '専務取締役'), P('総務 一', 'd@x.com')] }, { dept: '購買部', members: [P('常務 一', 'e@x.com', '常務取締役')] }
  ], right: [], names: {} };
  const ch3 = oc.buildOrgChart(ocOrg3, []);
  check('組織図: 「取締役会長」「代表取締役」は①(会長が先)、「専務取締役」は部門のグループにいても②', ch3.l1.map(p => p.name).join() === '友藤 昭弘,友藤 忠昭' && ch3.l2.map(p => p.name + ':' + p.title).join() === '東 伸考:専務取締役');
  check('組織図: ②の人は部門の列に重ねて出さない・「常務取締役」は①②に入らない', !JSON.stringify(ch3.columns.find(c => c.name === '総務部')).includes('東 伸考') && ch3.columns.find(c => c.name === '総務部').sections[0].members.length === 1 && !ch3.l1.concat(ch3.l2).some(p => p.name === '常務 一'));

  check('組織図: 管理画面用の一覧に、⑤の人と兼任が含まれる', oc.orgChartPeopleForAdmin(ocOrg, ocManual).some(r => r.dept === '購買部' && r.name === '課長 一郎') && oc.buildOrgChart({ left: [], right: [], names: {} }, []).columns.length === oc.ORG_CHART_FRAME.columns.length);

  // 年間カレンダー: shift_holiday は文字枠(ラベル)を赤で表示し、日付枠は色を付けない
  const w = load(['common.js', 'workCalendar.js'], ['dayLabelsHtml']);
  const sh = w.dayLabelsHtml([{ type: 'shift_holiday', team: '', label: '創立記念日' }]);
  check('shift_holiday: 文字枠が赤(背景#d64545・白文字)', sh.includes('background:#d64545') && sh.includes('color:#ffffff') && sh.includes('創立記念日'), sh.slice(0, 160));
  check('shift_holiday: 班があれば「A班 …」', w.dayLabelsHtml([{ type: 'shift_holiday', team: 'A', label: '特別休' }]).includes('A班 特別休'));
  check('shift_holiday: labelが空なら「休日」', w.dayLabelsHtml([{ type: 'shift_holiday', team: '', label: '' }]).includes('>休日<'));
  check('shift_holiday: 他の種類(祝日)の見た目は変わらない', !w.dayLabelsHtml([{ type: 'holiday', team: '', label: '祝日' }]).includes('#d64545'));
  process.exit(done() ? 1 : 0);
})().catch(e => { console.error('TEST ERROR', e); process.exit(2); });
