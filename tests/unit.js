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

const c = load(['common.js'], ['kindOfCategories', 'categoriesWithKind', 'meetingKindFieldHtml', 'tileLabelHtml', 'linkify', 'extractUrls', 'eventLinksHtml', 'displayName', 'fullNameOf', 'jstDateKey', 'isBeforeHireDate', 'employeeTypeRank', 'compareMembersByRank', 'sortKeyFromEmail', 'compareRomajiGojuon', 'withTimeout', 'surname', 'esc', 'phoneListOf', 'searchPortalPages', 'isShiftTeamEligible', 'calendarGroupFor']);

// 名前
check('displayName: 会社名の括弧書きを除く(全角)', c.displayName('本田 悠(吉村一建設)') === '本田 悠');
check('displayName: 会社名の括弧書きを除く(半角)', c.displayName('本田 悠 (ゆめすみか)') === '本田 悠');
check('displayName: 該当しない名前は変えない', c.displayName('山田  太郎(営業)') === '山田  太郎(営業)');
check('displayName: 括弧書きだけなら元のまま', c.displayName('(吉村一建設)') === '(吉村一建設)');
check('fullNameOf: 姓 名(半角スペース1つ)', c.fullNameOf('本田', '悠', 'x') === '本田 悠');
check('fullNameOf: 姓か名が空なら表示名', c.fullNameOf('本田', '', '本田 悠(吉村一建設)') === '本田 悠');
check('fullNameOf: 前後の空白を除く', c.fullNameOf(' 本田 ', ' 悠 ', 'x') === '本田 悠');
check('surname: 全角スペース区切り', c.surname('本田　悠') === '本田');
check('打ち合わせの区分: 分類項目から登録済みの区分を1つ取り出す(無ければ空)', c.kindOfCategories(['赤', '初回', '再提案'], ['初回', '再提案']) === '初回' && c.kindOfCategories(['赤'], ['初回']) === '' && c.kindOfCategories(null, ['初回']) === '' && c.kindOfCategories(['初回'], []) === '');
check('打ち合わせの区分: 保存する分類項目は、登録済みの区分だけを入れ替え、ほかの分類項目は残す', JSON.stringify(c.categoriesWithKind(['赤', '初回'], ['初回', '再提案'], '再提案')) === JSON.stringify(['赤', '再提案']) && JSON.stringify(c.categoriesWithKind(['赤', '初回'], ['初回'], '')) === JSON.stringify(['赤']) && JSON.stringify(c.categoriesWithKind(undefined, ['初回'], '初回')) === JSON.stringify(['初回']) && JSON.stringify(c.categoriesWithKind(['古い区分'], ['初回'], '初回')) === JSON.stringify(['古い区分', '初回']));
check('打ち合わせの区分: プルダウンは「選択しない」を先頭に持ち、選択中の値は一覧に無くても残す。値はエスケープする', c.meetingKindFieldHtml('f-kind', '').includes('id="f-kind"') && c.meetingKindFieldHtml('f-kind', '').includes('選択しない') && c.meetingKindFieldHtml('f-kind', '旧<b>').includes('旧&lt;b&gt;') && !c.meetingKindFieldHtml('f-kind', '旧<b>').includes('<b>') && c.meetingKindFieldHtml('f-kind', '旧').includes('value="旧" selected'));
check('tileLabelHtml: 「(」(全角・半角)があればその直前で改行し、2行目に「(」から出す。無い・先頭・空・HTMLは改行しない/エスケープ', c.tileLabelHtml('経費精算システム（Web入力）') === '経費精算システム<br>（Web入力）' && c.tileLabelHtml('勤怠(jinjer)') === '勤怠<br>(jinjer)' && c.tileLabelHtml('就業規則') === '就業規則' && c.tileLabelHtml('(旧)規程') === '(旧)規程' && c.tileLabelHtml('（旧）規程') === '（旧）規程' && c.tileLabelHtml('') === '' && c.tileLabelHtml(null) === '' && c.tileLabelHtml('<b>x(<i>)') === '&lt;b&gt;x<br>(&lt;i&gt;)');
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
// URLのリンク化(2026-10-26・ユーザー依頼): http・httpsだけ。新しいタブ・noopener。他の文字は必ずエスケープ。日本語・末尾の句読点・閉じ括弧はURLに含めない
const NL = String.fromCharCode(10);
check('linkify: https のURLを、新しいタブで開くリンクにする(rel=noopener noreferrer)', c.linkify('資料: https://example.com/a?x=1&y=2 です') === '資料: <a href="https://example.com/a?x=1&amp;y=2" target="_blank" rel="noopener noreferrer" style="color:#1e5fa8;text-decoration:underline;word-break:break-all">https://example.com/a?x=1&amp;y=2</a> です', c.linkify('資料: https://example.com/a?x=1&y=2 です'));
check('linkify: URLの直後の日本語・句読点・閉じ括弧はリンクに含めない', c.linkify('(https://a.example/x)です。').includes('>https://a.example/x</a>)です。') && c.linkify('https://a.example/x。次').includes('>https://a.example/x</a>。次') && c.linkify('https://a.example/x、次').includes('>https://a.example/x</a>、次'));
check('linkify: 他のHTML・javascript: はリンクにせず、エスケープする', c.linkify('<script>alert(1)</script> javascript:alert(1) <a href="x">') === '&lt;script&gt;alert(1)&lt;/script&gt; javascript:alert(1) &lt;a href=&quot;x&quot;&gt;' && !c.linkify('"><img src=x onerror=alert(1)> https://a.example/"><b>').includes('<img') && !c.linkify('https://a.example/"onmouseover="x').includes('onmouseover="x"'));
check('linkify: 空・null・URLなしの文字はそのまま(エスケープのみ)。改行は保つ', c.linkify('') === '' && c.linkify(null) === '' && c.linkify('a' + NL + 'b<') === 'a' + NL + 'b&lt;');
check('extractUrls: 本文のURLを重複なし・最大件数で取り出す(Teams会議のURLを含む)', c.extractUrls('Teams: https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=%7b%7d' + NL + 'また https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=%7b%7d と https://b.example/p. https://c.example/q https://d.example/r', 3).join('|') === 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=%7b%7d|https://b.example/p|https://c.example/q' && c.extractUrls('', 3).length === 0 && c.extractUrls(null).length === 0);
check('eventLinksHtml: 予定カードのURLの行は、新しいタブ・1行に収める・エスケープ済み。URLが無ければ空', c.eventLinksHtml(['https://a.example/x?y=1&z=2']).includes('target="_blank"') && c.eventLinksHtml(['https://a.example/x?y=1&z=2']).includes('text-overflow:ellipsis') && c.eventLinksHtml(['https://a.example/x?y=1&z=2']).includes('y=1&amp;z=2') && c.eventLinksHtml([]) === '' && c.eventLinksHtml(undefined) === '');
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
  // 社員名簿: 吉村一建設側は従業員の種類 1(会長・社長)と 2(専務取締役)を、役職の見出しとして一番上に出す(グループに入っていない専務も消えない)
  const hp = [u('t-zeta@yoshimuraichi.com', '専務 東', '2', '専務取締役'), u('m-mm@yoshimuraichi.com', '種類2の別の人', '2', '部長'), u('n-nn@yoshimuraichi.com', '種類2で役職なし', '2', ''), u('a-aoki@yoshimuraichi.com', '社長 友', '1', '代表取締役'), u('k-kato@yoshimuraichi.com', '会長 友', '1', '取締役会長'), u('s-sato@yoshimuraichi.com', '営業 一')];
  const hpDepts = { 's-sato@yoshimuraichi.com': ['営業部'], 'm-mm@yoshimuraichi.com': ['営業部'], 'n-nn@yoshimuraichi.com': ['営業部'] };
  const hg = o.buildGroups(hp, ['会長', '社長', '専務'], { deptsOf: x => hpDepts[x.email] || [], deptOrder: ['営業部'], headingTypes: ['1', '2'], headingRank: ['会長', '社長', '代表取締役', '専務'] });
  check('社員名簿: 従業員の種類1・2(2は役職に「専務」を含む人だけ)は役職の見出しで一番上(取締役会長→代表取締役→専務取締役の順)。グループに入っていない専務も出る', hg.map(g => g.dept).join() === '取締役会長,代表取締役,専務取締役,営業部' && hg.find(g => g.dept === '営業部').members.map(m => m.name).sort().join() === ['営業 一', '種類2の別の人', '種類2で役職なし'].sort().join(), hg.map(g => g.dept).join());
  const hgDefault = o.buildGroups(hp, ['会長', '社長', '専務'], { deptsOf: x => hpDepts[x.email] || [], deptOrder: ['営業部'] });
  check('社員名簿: 見出しの種類を指定しない既定(ゆめすみか側など)は、従来どおり種類1だけ(種類2はグループに入っていなければ出ない)', hgDefault.map(g => g.dept).sort().join() === ['代表取締役', '取締役会長', '営業部'].sort().join() && !hgDefault.some(g => g.dept === '専務取締役'));
  // 種類2を専務以外の人に付けても、その人は部門のグループに残る(役職が空の種類2も見出しにはしない)
  check('LEFT_GROUP_ORDER: 総務部が一番下', o.LEFT_GROUP_ORDER[o.LEFT_GROUP_ORDER.length - 1] === '総務部');
  const sp = o.splitByCompany([u('x@yumesumika.com', 'ゆめ'), u('y@yoshimuraichi.com', '吉村'), u('n-morishita@yoshimuraichi.com', '森下'), u('s-tada@yumesumika.com', '多田')]);
  // ゆめすみかの部門グループに入っている人は、@yoshimuraichi.com でも、左列に固定されている @yumesumika.com でも、右列(グループ未所属はこれまでどおり)
  const spg = o.splitByCompany([u('k@yoshimuraichi.com', '小谷'), u('s-tada@yumesumika.com', '多田'), u('y@yoshimuraichi.com', '吉村'), u('x@yumesumika.com', 'ゆめ')], { 'k@yoshimuraichi.com': ['設計'], 's-tada@yumesumika.com': ['福田/泉佐野展示場'] });
  check('splitByCompany: ゆめすみかのグループに入っている人は右列(ドメイン・左列固定より優先)。未所属はドメインどおり', spg.right.map(x => x.name).join() === '小谷,多田,ゆめ' && spg.left.map(x => x.name).join() === '吉村', JSON.stringify(spg));
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

  // 組織図(orgChart.js): 従業員の種類の数字(1〜4)と手入力の役職から、5階層の枠組みに振り分ける(2026-10-20・ユーザーが整理)
  //   吉村一建設側: 1=①会長・社長 / 2=②専務取締役 / 3=③室長・マネージャー・部長 / 4=④次長 / なし=⑤。ゆめすみか側: 1=③常務取締役 / 2=④マネージャー / それ以外=⑤
  const oc = load(['common.js', 'orgChart.js'], ['buildOrgChart', 'ORG_CHART_FRAME', 'orgChartPeopleForAdmin', 'orgHanMatch']);
  const P = (name, email, title = '', empType = '') => ({ name, email, title, empType, phone: '' });
  const ocOrg = {
    left: [
      { dept: '取締役会長', members: [P('友藤 昭弘', 'a@x.com', '取締役会長', '1')] }, { dept: '代表取締役', members: [P('友藤 忠昭', 'b@x.com', '代表取締役', '1')] },
      { dept: '総務部', members: [P('東 伸考', 'c@x.com', '専務取締役', '2'), P('総務 一', 'z1@x.com')] }, // 専務は、どの部門のグループにいても②(種類=2)
      { dept: '購買部', members: [P('靍谷 佳憲', 'd@x.com', '取締役部長', '3'), P('次長 太郎', 'e@x.com', '次長', '4'), P('主任 花子', 'f@x.com'), P('課長 一郎', 'g@x.com'), P('一般 次郎', 'h@x.com')] },
      { dept: '不動産部', members: [P('広沢 成男', 'i@x.com')] },
      { dept: '物流事業係', members: [P('荒井 正義', '')] }, { dept: '工務部(本社)', members: [P('工務 太郎', 'j@x.com', '部長', '3')] }
    ],
    right: [
      { dept: '常務取締役', members: [P('森下 直美', 'k@y.com', '常務取締役', '1')] }, { dept: 'マネージャー', members: [P('大平 国弘', 'l@y.com', 'マネージャー', '2')] },
      { dept: '福田/泉佐野展示場', members: [P('店 長', 'm@y.com'), P('平 社員', 'n@y.com'), P('三 番', 'o@y.com', '', '3')] }
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
  check('組織図: ①(従業員の種類1)=会長・社長が1つの枠(会長が先)、②(種類2)=専務取締役', ch.l1.map(p => p.name).join() === '友藤 昭弘,友藤 忠昭' && ch.l2.map(p => p.name + ':' + p.title).join() === '東 伸考:専務取締役');
  check('組織図: ②の人は、いたグループ(総務部)の列には重ねて出さない', colOf('総務部').sections[0].members.map(m => m.name).join() === '総務 一' && colOf('総務部').l3.length === 0);
  check('組織図: 購買部の③は種類3(MS365の役職を表示)、④は種類4', colOf('購買部').l3.map(p => p.name + ':' + p.title).join() === '靍谷 佳憲:取締役部長' && colOf('購買部').l4.map(p => p.name).join() === '次長 太郎');
  check('組織図: ⑤(種類なし)は手入力の役職順(課長→主任→役職なし)', colOf('購買部').sections[0].members.map(m => m.name + ':' + m.title).join() === '課長 一郎:課長,主任 花子:主任,一般 次郎:');
  check('組織図: ゆめすみかは③=種類1(常務取締役)・④=種類2(マネージャー)、⑤は店長が先。種類3以降は⑤', colOf('㈱ゆめすみか').l3[0].name === '森下 直美' && colOf('㈱ゆめすみか').l3[0].title === '常務取締役' && colOf('㈱ゆめすみか').l4[0].name === '大平 国弘' && colOf('㈱ゆめすみか').sections[0].members.map(m => m.name).join() === '店 長,平 社員,三 番');
  check('組織図: 兼任(手入力で部門を指定)は、MS365のグループに無くても④に載る(手入力の行は役職の文字で判定)', colOf('不動産部').l4.map(p => p.name + ':' + p.title).join() === '森下 直美:次長(兼任)');
  check('組織図: メールの無い手動メンバー(荒井 正義)は氏名のキーで手入力の役職が付く。物流事業係などは工務部ではなく、独立した部門(sides)', ch.sides.find(c => c.name === '物流事業係').sections[0].members[0].title === '主任' && !JSON.stringify(colOf('工務部')).includes('荒井') && ch.sides.map(c => c.name).join() === 'エクステリア事業係,外壁・2×4事業課(㈱来夢エンジニア),物流事業係,フレミング大工');
  check('組織図: 工務部の部長(種類3)は③に載る', colOf('工務部').l3.map(p => p.name).join() === '工務 太郎');
  // 従業員の種類が無ければ、役職が「部長」でも⑤(種類で決める)。「次長(兼任)」など括弧つきの手入力は、兼任の追加行だけ④に載る
  const ch2 = oc.buildOrgChart({ left: [{ dept: '総務部', members: [P('部長 本人', 'p1@x.com', '部長'), P('代理 人', 'p2@x.com', '部長代理', '3')] }], right: [{ dept: '福田/泉佐野展示場', members: [P('代 理', 'q1@y.com', '店長代理'), P('店 長', 'q2@y.com', '店長'), P('係 長', 'q3@y.com', '係長')] }], names: {} }, []);
  check('組織図: 従業員の種類の記載なしは、役職が「部長」でも⑤(階層は種類の数字で決まる)', ch2.columns.find(c => c.name === '総務部').l3.map(p => p.name).join() === '代理 人' && ch2.columns.find(c => c.name === '総務部').sections[0].members.map(p => p.name).join() === '部長 本人');
  check('組織図: ⑤の順は 店長→係長→店長代理(「店長代理」が「店長」と同じ順位にならない)', ch2.columns.find(c => c.name === '㈱ゆめすみか').sections[0].members.map(m => m.title).join() === '店長,係長,店長代理');
  // 兼任の手入力の行(従業員の種類を持たない)は、役職の文字で③④を判定する。「部長代理」などは⑤
  const chAdd = oc.buildOrgChart({ left: [], right: [], names: { 'a@x.com': '甲', 'b@x.com': '乙', 'c@x.com': '丙' } }, [{ email: 'a@x.com', dept: '購買部', title: '部長(兼任)', sort: 0 }, { email: 'b@x.com', dept: '購買部', title: '部長代理', sort: 0 }, { email: 'c@x.com', dept: '購買部', title: '次長', sort: 0 }]);
  check('組織図: 兼任の追加行は、「部長(兼任)」=③・「次長」=④・「部長代理」=⑤', chAdd.columns.find(c => c.name === '購買部').l3.map(p => p.name).join() === '甲' && chAdd.columns.find(c => c.name === '購買部').l4.map(p => p.name).join() === '丙' && chAdd.columns.find(c => c.name === '購買部').sections[0].members.map(p => p.name).join() === '乙');

  // グループに入っていない専務取締役(種類2)・常務取締役(ゆめすみか。種類1)も、会社別の全員の一覧(org.users)から拾う
  const chU = oc.buildOrgChart({ left: [{ dept: '購買部', members: [P('購買 一', 'z@x.com')] }], right: [{ dept: '福田/泉佐野展示場', members: [P('店 長', 'm@y.com')] }], names: {},
    users: { left: [P('東 伸考', 'c@x.com', '専務取締役', '2'), P('購買 一', 'z@x.com')], right: [P('森下 直美', 'k@y.com', '常務取締役', '1'), P('大平 国弘', 'l@y.com', 'マネージャー', '2'), P('店 長', 'm@y.com')] } }, []);
  check('組織図: どのグループにも入っていない専務取締役(種類2)も②に出る', chU.l2.map(p => p.name + ':' + p.title).join() === '東 伸考:専務取締役');
  check('組織図: どのグループにも入っていないゆめすみかの種類1・2も③④に出る', chU.columns.find(c => c.name === '㈱ゆめすみか').l3.map(p => p.name).join() === '森下 直美' && chU.columns.find(c => c.name === '㈱ゆめすみか').l4.map(p => p.name).join() === '大平 国弘' && chU.columns.find(c => c.name === '購買部').sections[0].members.map(m => m.name).join() === '購買 一');

  // 工務部: 従業員の種類(3以上)が2種類以上あれば、小さい数字=③部長・次の数字=④次長に分ける(番号が3・4でなくても)
  const chK = oc.buildOrgChart({ left: [{ dept: '工務部(本社)', members: [P('千葉 由樹', 'k1@x.com', '部長', '3'), P('佐藤 末明', 'k2@x.com', '次長', '5'), P('本社 一', 'k3@x.com')] }, { dept: '工務部(平野)', members: [P('平野 二', 'k4@x.com', '', '7')] }], right: [], names: {} }, []);
  const kk = chK.columns.find(c => c.name === '工務部');
  check('組織図: 工務部は、従業員の種類の小さい数字=③部長、次の数字=④次長に分かれる(同じ枠に入らない)', kk.l3.map(p => p.name).join() === '千葉 由樹' && kk.l4.map(p => p.name).join() === '佐藤 末明' && kk.sections.flatMap(s => s.members).map(m => m.name).sort().join() === ['本社 一', '平野 二'].sort().join());
  const kk2 = oc.buildOrgChart({ left: [{ dept: '工務部(本社)', members: [P('次長 のみ', 'k5@x.com', '次長', '4')] }], right: [], names: {} }, []).columns.find(c => c.name === '工務部');
  const kk3 = oc.buildOrgChart({ left: [{ dept: '工務部(本社)', members: [P('千葉 由樹', 'k6@x.com', '部長', '3'), P('佐藤 末明', 'k7@x.com', '次長', '3')] }], right: [], names: {} }, []).columns.find(c => c.name === '工務部');
  check('組織図: 工務部は、部長と次長の種類の数字が同じでも、役職が「次長」なら④に分かれる', kk3.l3.map(p => p.name).join() === '千葉 由樹' && kk3.l4.map(p => p.name).join() === '佐藤 末明');
  check('組織図: 工務部に種類が1つだけのときは、従来どおり(4=④次長。③にはしない)', kk2.l3.length === 0 && kk2.l4.map(p => p.name).join() === '次長 のみ');

  // 兼任の追加で区分を指定: 「部門名/区分名」の dept は、その区分に載る(指定なしは先頭の区分)
  const chSec = oc.buildOrgChart({ left: [], right: [{ dept: '福田/泉佐野展示場', members: [P('福田 一', 'f1@y.com')] }, { dept: '設計', members: [P('設計 一', 'd1@y.com')] }], names: { 'x1@x.com': '兼任 甲', 'x2@x.com': '兼任 乙', 'x3@x.com': '兼任 丙' } },
    [{ email: 'x1@x.com', dept: '㈱ゆめすみか/設計', title: '設計(兼)', sort: 0 }, { email: 'x2@x.com', dept: '㈱ゆめすみか', title: '店長(兼)', sort: 0 }, { email: 'x3@x.com', dept: '㈱ゆめすみか/存在しない区分', title: '主任(兼)', sort: 0 }]);
  const ymSec = chSec.columns.find(c => c.name === '㈱ゆめすみか').sections;
  check('組織図: 兼任の追加で区分を指定すると、その区分(ゆめすみかの設計)に載る・指定なしや存在しない区分は先頭の区分', ymSec.find(s => s.label === '設計').members.map(m => m.name).join() === '兼任 甲,設計 一' && ymSec.find(s => s.label === '福田/泉佐野展示場').members.map(m => m.name).sort().join() === ['福田 一', '兼任 乙', '兼任 丙'].sort().join());

  // 兼任の追加で選ぶ「MS365のグループ」と、組織図の部門・区分の対応(社員名簿のグループがすべて含まれる)
  { // 班(2026-10-26): 「部署グループのアドレスの@より前 + -han」で始まるグループ。親の区分のすぐ右の区分になり、親の一覧からは外れる。従業員の種類は見ない
    const parents = [{ label: '工務部(本社)', groupMail: 'koumu_1@yoshimuraichi.com' }, { label: '工務部(平野)', groupMail: 'koumu_2@yoshimuraichi.com' }];
    const hm = oc.orgHanMatch([{ mail: 'koumu_1-han2@yoshimuraichi.com', displayName: '2班' }, { mail: 'koumu_1-han1@yoshimuraichi.com', displayName: '1班' }, { mail: 'koumu_2-han1@yoshimuraichi.com', displayName: ' 平野1班 ' }, { mail: 'koumu_1@yoshimuraichi.com', displayName: '本社' }, { mail: 'koumu_1-han1@other.com', displayName: '他' }, { mail: 'koumu_10-han1@yoshimuraichi.com', displayName: '別' }, { mail: 'sekkei-han1@yoshimuraichi.com', displayName: '設計' }, { mail: '', displayName: 'メールなし' }], parents);
    check('組織図の班: 部署グループのアドレス+-hanで始まるグループだけを班として見つける(同じドメインのみ・親のグループ自身や前半が違うものは対象外)・アドレス順・表示名が枠の名前', hm.map(h => h.parent + ':' + h.label).join() === '工務部(本社):1班,工務部(本社):2班,工務部(平野):平野1班', JSON.stringify(hm));
    const Pm = (name, email, empType, title) => ({ name, email, title: title || '', empType: empType || '', phone: '' });
    const hOrg = { left: [{ dept: '工務部(本社)', members: [Pm('甲', 'a@x.com'), Pm('乙', 'b@x.com', '3'), Pm('丙', 'c@x.com')] }, { dept: '工務部(平野)', members: [Pm('丁', 'd@x.com')] }], right: [], names: {}, users: { left: [Pm('戊', 'z@x.com')], right: [] },
      han: [{ parent: '工務部(本社)', label: '1班', emails: ['b@x.com', 'z@x.com'] }, { parent: '工務部(本社)', label: '2班', emails: ['c@x.com'] }] };
    const hc = oc.buildOrgChart(hOrg, [{ email: 'a@x.com', dept: '工務部/2班', title: '', sort: 0 }]).columns.find(c => c.name === '工務部');
    check('組織図の班: 班は親の区分(本社)のすぐ右に並び(本社・1班・2班・平野・西宮)、班の人は親の一覧から外れる。親のグループにいない人も班に載る', hc.sections.map(x => x.label).join() === '本社,1班,2班,平野,西宮' && hc.sections[0].members.map(m => m.name).join() === '甲' && hc.sections[1].members.map(m => m.name).join() === '乙,戊' && hc.sections[2].members.map(m => m.name).join() === '丙', JSON.stringify(hc.sections.map(x => [x.label, x.members.map(m => m.name)])));
    check('組織図の班: 班の人は従業員の種類を見ない(種類3でも③に上がらず、班の一覧に載る)。同じ人は1回だけ(兼任の追加が班の区分でも、すでに載っていれば重ねない)', hc.l3.length === 0 && hc.sections.flatMap(x => x.members).filter(m => m.name === '甲').length === 1);
    const hc0 = oc.buildOrgChart({ ...hOrg, han: undefined }, []).columns.find(c => c.name === '工務部');
    check('組織図の班: 班が無ければ、これまでどおり(班の区分なし・種類3は③)', hc0.sections.map(x => x.label).join() === '本社,平野,西宮' && hc0.l3.map(m => m.name).join() === '乙');
  }
  { // 人数(2026-10-26): 部門=③④⑤の全員(部長・次長も)+補足(person=1・count=人数)。兼任は数えない。工務事務は単独。班は区分として独立(部門の合計には含める)。会長・社長・専務は数えない
    const Pn = (name, email, empType, title) => ({ name, email, title: title || '', empType: empType || '', phone: '' });
    const cOrg = { left: [
      { dept: '会長', members: [Pn('会長', 'ch@x.com', '1', '会長')] },
      { dept: '購買部', members: [Pn('部長', 'b1@x.com', '3', '部長'), Pn('次長', 'b2@x.com', '4', '次長'), Pn('甲', 'b3@x.com'), Pn('乙', 'b4@x.com')] },
      { dept: '工務部(本社)', members: [Pn('本1', 'k1@x.com'), Pn('本2', 'k2@x.com'), Pn('班1', 'k3@x.com'), Pn('事務', 'k4@x.com', '', '工務事務')] }
    ], right: [], names: {}, users: { left: [], right: [] },
    han: [{ parent: '工務部(本社)', label: '1班', emails: ['k3@x.com'] }],
    extras: [{ id: 1, dept: 'フレミング大工', kind: 'person', title: 'リーダー', name: '岸上大介', count: 0, sort: 1 }, { id: 2, dept: 'フレミング大工', kind: 'person', title: 'リーダー', name: '近藤正明', count: 0, sort: 2 }, { id: 3, dept: 'フレミング大工', kind: 'count', title: 'フィリピン', count: 3, sort: 3 }, { id: 4, dept: '設計企画部', kind: 'count', title: 'フィリピンCADセンター', count: 3, sort: 1 }] };
    const cc = oc.buildOrgChart(cOrg, [{ email: 'b3@x.com', dept: '購買部', title: '係長(兼任)', sort: 0 }, { email: 'z9@x.com', dept: '購買部', title: '次長(兼任)', sort: 0 }]);
    const col = n => cc.columns.find(c => c.name === n), side = n => cc.sides.find(c => c.name === n);
    check('組織図の人数: 部門=部長・次長・一覧の人(購買部=部長・次長・乙の3。役職に(兼任)の注記がある甲・兼任の追加行は数えない)', col('購買部').count === 3, String(col('購買部').count));
    check('組織図の人数: 班は区分として独立して数え(1班=1)、部門の合計には含める(工務部=本社2+班1=3。工務事務は別)。工務事務は単独(1)', col('工務部').sections.find(s => s.label === '本社').count === 2 && col('工務部').sections.find(s => s.label === '1班').count === 1 && col('工務部').count === 3 && cc.jimu.count === 1, JSON.stringify([col('工務部').count, cc.jimu.count]));
    check('組織図の人数: 補足は部門の人数に足す(フレミング大工=リーダー2+フィリピン3=5。設計企画部=0+3=3)。補足行は一番下・手動の人は役職+氏名', side('フレミング大工').count === 5 && col('設計企画部').count === 3 && side('フレミング大工').sections[0].members.map(m => m.extra === 'count' ? m.title + m.count : m.title + m.name).join() === 'リーダー岸上大介,リーダー近藤正明,フィリピン3', JSON.stringify(side('フレミング大工').sections[0].members));
    check('組織図の人数: 全体の合計=全部門+工務事務+補足+会長・社長・専務取締役(部門の人数には入れない)', cc.total === cc.columns.reduce((n, c) => n + c.count, 0) + cc.sides.reduce((n, c) => n + c.count, 0) + cc.jimu.count + cc.l1.length + cc.l2.length && cc.total === 3 + 3 + 3 + 5 + 1 + 1, String(cc.total));
    const jx = oc.buildOrgChart({ ...cOrg, extras: [{ id: 9, dept: '購買部', kind: 'count', title: '工務事務', count: 4, sort: 1 }] }, []);
    check('組織図の補足: 行の名前が「工務事務」の補足行は、工務事務の箱に入らず、部門の枠の補足行のまま(人数に足される)', jx.jimu.count === 1 && jx.columns.find(c => c.name === '購買部').count === 4 + 4 && jx.columns.find(c => c.name === '購買部').sections.flatMap(x => x.members).some(m => m.extra === 'count' && m.count === 4), JSON.stringify([jx.jimu.count, jx.columns.find(c => c.name === '購買部').count]));
    const noEx = oc.buildOrgChart({ ...cOrg, extras: undefined, han: undefined }, []);
    check('組織図の補足: 補足が無ければ、補足行のみの部門は空のまま(これまでどおり)。管理画面の役職一覧には補足行を出さない', noEx.sides.find(c => c.name === 'フレミング大工').count === 0 && oc.orgChartPeopleForAdmin(cOrg, []).every(r => !String(r.key).startsWith('extra:')));
  }
  { // 区分の名前の変更(福田展示場→福田/泉佐野展示場。2026-10-26): 旧い名前で保存された手入力の行(兼任)も、新しい名前の区分に載る。新しい名前で保存した行も載る
    const Pa = (name, email) => ({ name, email, title: '', empType: '', phone: '' });
    const aOrg = { left: [], right: [{ dept: '福田/泉佐野展示場', members: [Pa('福一', 'f1@x.com')] }, { dept: '設計', members: [Pa('設一', 's1@x.com')] }], names: { 'o1@x.com': '旧名の兼任', 'n1@x.com': '新名の兼任' }, users: { left: [], right: [] } };
    const aCol = oc.buildOrgChart(aOrg, [{ email: 'o1@x.com', dept: '㈱ゆめすみか/福田展示場', title: '店長(兼任)', sort: 0 }, { email: 'n1@x.com', dept: '㈱ゆめすみか/福田/泉佐野展示場', title: '係長(兼任)', sort: 0 }]).columns.find(c => c.name === '㈱ゆめすみか');
    const fk = aCol.sections.find(x => x.label === '福田/泉佐野展示場');
    check('組織図: 区分名「福田/泉佐野展示場」(スラッシュを含む)に、新旧どちらの名前で保存した兼任の行も載る(他の区分には載らない)', !!fk && fk.members.map(m => m.name).sort().join() === '新名の兼任,旧名の兼任,福一' && aCol.sections.find(x => x.label === '設計').members.map(m => m.name).join() === '設一', JSON.stringify(aCol.sections.map(x => [x.label, x.members.map(m => m.name)])));
  }
  const ocAll = load(['common.js', 'roomsData.js', 'orgData.js', 'orgChart.js'], ['orgChartGroupChoices', 'LEFT_GROUPS', 'YUMESUMIKA_GROUPS']);
  const gch = ocAll.orgChartGroupChoices();
  const gmap = Object.fromEntries(gch.map(c => [c.label, c.dept]));
  check('組織図: 兼任の追加で選ぶMS365のグループは、社員名簿のグループ(吉村一建設14+ゆめすみか7)をすべて含み、部門・区分に対応づく', [...ocAll.LEFT_GROUPS, ...ocAll.YUMESUMIKA_GROUPS].every(g => gmap[g.label]) && gch.length === 21, gch.length + ' ' + [...ocAll.LEFT_GROUPS, ...ocAll.YUMESUMIKA_GROUPS].filter(g => !gmap[g.label]).map(g => g.label).join());
  check('組織図: グループ→部門/区分(設計→㈱ゆめすみか/設計・工務部(平野)→工務部/平野・購買部→購買部・来夢エンジニア→事業課)', gmap['設計'] === '㈱ゆめすみか/設計' && gmap['工務部(平野)'] === '工務部/平野' && gmap['購買部'] === '購買部' && gmap['来夢エンジニア'] === '外壁・2×4事業課(㈱来夢エンジニア)');

  // ⑤の並びは、手入力の表示順の小さい順(役職に関係なく)。役職が空でも表示順だけの行で並べられる。同じ表示順なら役職の順
  const chSort = oc.buildOrgChart({ left: [{ dept: '購買部', members: [P('甲 一', 's1@x.com'), P('乙 二', 's2@x.com'), P('丙 三', 's3@x.com'), P('丁 四', 's4@x.com'), P('戊 五', 's5@x.com', '主任')] }], right: [], names: {} },
    [{ email: 's1@x.com', dept: '', title: '', sort: 3 }, { email: 's2@x.com', dept: '', title: '課長', sort: 2 }, { email: 's3@x.com', dept: '', title: '', sort: 1 }]);
  check('組織図: ⑤は表示順の小さい順(役職が空の人も)。表示順なし(0)が先頭で、同じ0の中は役職の順→名簿の順。役職が空の行はMS365の役職を消さない', chSort.columns.find(c => c.name === '購買部').sections[0].members.map(m => m.name).join() === '戊 五,丁 四,丙 三,乙 二,甲 一' && chSort.columns.find(c => c.name === '購買部').sections[0].members[0].title === '主任');

  // 工務事務: 役職(手入力またはMS365)が「工務事務」の人は、本来の箱の一覧から外し、1つの箱(chart.jimu)にまとめる
  const jOrg = { left: [{ dept: 'カスタマーサポート室', members: [P('CS 一', 'j1@x.com'), P('CS 二', 'j2@x.com')] }, { dept: 'リフォーム部', members: [P('リ 一', 'j3@x.com', '工務事務')] }, { dept: '工務部(本社)', members: [P('工 一', 'j4@x.com'), P('工 二', 'j5@x.com')] }, { dept: '購買部', members: [P('購 一', 'j6@x.com')] }], right: [], names: {} };
  const jManual = [{ email: 'j1@x.com', dept: '', title: '工務事務', sort: 2 }, { email: 'j4@x.com', dept: '', title: '工務事務', sort: 1 }, { email: 'j5@x.com', dept: '', title: '事務員', sort: 0 }, { email: 'j6@x.com', dept: '', title: '工務事務', sort: 0 }];
  const chJ = oc.buildOrgChart(jOrg, jManual);
  check('組織図: 工務事務の人(手入力・MS365の役職)は、1つの箱にまとまり、並びは表示順の小さい順', chJ.jimu.name === '工務事務' && chJ.jimu.members.map(m => m.name).join() === 'リ 一,購 一,工 一,CS 一' && chJ.jimu.parents.join() === 'カスタマーサポート室,リフォーム部,工務部');
  check('組織図: 工務事務の人は、本来の箱(⑤の一覧)から外れる。「事務員」は区別せず役職として残る', chJ.columns.find(c => c.name === 'カスタマーサポート室').sections[0].members.map(m => m.name).join() === 'CS 二' && chJ.columns.find(c => c.name === 'リフォーム部').sections[0].members.length === 0 && chJ.columns.find(c => c.name === '工務部').sections[0].members.map(m => m.name + ':' + m.title).join() === '工 二:事務員' && chJ.columns.find(c => c.name === '購買部').sections[0].members.length === 0);
  { // 「工務事務 主任」(先頭が工務事務+空白)は箱に入り、箱の中で「主任」が氏名の横に出る。「工務事務課長」のように空白なしでは入らない
    const sOrg = { left: [{ dept: 'カスタマーサポート室', members: [P('主 一', 's1@x.com'), P('主 二', 's2@x.com'), P('主 三', 's3@x.com')] }], right: [], names: {} };
    const sMan = [{ email: 's1@x.com', dept: '', title: '工務事務 主任', sort: 0 }, { email: 's2@x.com', dept: '', title: '工務事務　係長', sort: 0 }, { email: 's3@x.com', dept: '', title: '工務事務課長', sort: 0 }];
    const chS = oc.buildOrgChart(sOrg, sMan);
    check('組織図: 「工務事務 主任」(半角・全角の空白)は工務事務の箱に入り、続く役職が出る。空白なしの「工務事務課長」は入らない', chS.jimu.members.map(m => m.name + ':' + m.jimuSub).join() === '主 一:主任,主 二:係長' && chS.columns.find(c => c.name === 'カスタマーサポート室').sections.flatMap(s => s.members).some(m => m.name === '主 三'), JSON.stringify(chS.jimu.members.map(m => m.name + ':' + m.jimuSub)));
  }
  check('組織図: 工務事務の人も、管理画面の役職の一覧に出る(役職を直せる)', oc.orgChartPeopleForAdmin(jOrg, jManual).filter(r => r.dept === '工務事務').length === 4);

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
