// 画面の確認(Edge をヘッドレスで操作。隔離したdevモードのサーバーに対して実行)
// 確認すること: 全ページの表示・PC/スマホ幅で横にはみ出さない・スマホのメニュー・お知らせの並びとNEW・
//               週の予定・スタッフ予定のタブ・通信失敗/無応答でも画面が表示される
// ※ 実際の会社のMS365(Graph)のデータでの表示は再現できない。テスト環境での確認は別に必要
'use strict';
const fs = require('fs');
const path = require('path');
const { ROOT, makeChecker, startSandbox, findEdge, launchEdge, sleep } = require('./lib/harness');
const { check, done } = makeChecker('browser');

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };

(async () => {
  const edge = findEdge();
  if (!edge) { console.log('SKIP  Edge が見つからないため画面の確認を省略します(EDGE_PATH で指定できます)'); process.exit(3); }
  const sb = await startSandbox();
  const br = await launchEdge(edge);
  const api = async (method, url, body) => {
    const r = await fetch(sb.base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return r.json().catch(() => null);
  };
  const noOverflow = "document.documentElement.scrollWidth <= window.innerWidth + 1";
  try {
    // ---- 全ページ: 表示される・横にはみ出さない(PC 1280 / スマホ 390) ----
    // 機能が無効な環境では配信されないページ(出勤状況=jinjerキーが必要。本日のお休み=ENABLE_DAYOFFS)は、無効のときに404であることを確認する
    const gated = ['attendance.html', 'today-off.html'];
    for (const p of gated) check(`${p}: キー未設定では配信されない(404)`, (await fetch(`${sb.base}/${p}`)).status === 404);
    const pages = fs.readdirSync(path.join(ROOT, 'public')).filter(f => f.endsWith('.html') && f !== 'igrace-login.html' && !gated.includes(f)).sort();
    for (const p of pages) {
      for (const w of [1280, 390]) {
        const shown = await br.open(`${sb.base}/${p}`, w);
        check(`${p} (${w}px): ログイン確認後に表示される`, shown);
        if (shown) {
          await sleep(500); // 初期描画の完了待ち
          const widths = await br.evaluate("[document.documentElement.scrollWidth, window.innerWidth].join('/')");
          check(`${p} (${w}px): 横にはみ出さない`, await br.evaluate(noOverflow), widths);
        }
      }
    }

    // ---- スマホ: ハンバーガーメニュー(第1段階) ----
    await br.open(`${sb.base}/index.html`, 390);
    const burger = await br.evaluate("!!document.querySelector('.portal-burger')");
    check('スマホ(390px): ハンバーガーボタンがある', burger);
    if (burger) {
      await br.evaluate("document.querySelector('.portal-burger').click()");
      check('スマホ: ボタンでメニューが開く', await br.evaluate("document.querySelector('.portal-mobile-menu').classList.contains('open')"));
      await br.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
      check('スマホ: Escでメニューが閉じる', await br.evaluate("!document.querySelector('.portal-mobile-menu').classList.contains('open')"));
    }
    await br.open(`${sb.base}/index.html`, 1280);
    check('PC(1280px): ハンバーガーは表示されない', await br.evaluate("(() => { const b = document.querySelector('.portal-burger'); return !b || getComputedStyle(b).display === 'none'; })()"));

    // ---- お知らせ: 固定/重要が先頭・NEW・期限切れは出さない ----
    const today = iso(new Date());
    await api('POST', '/api/admin/news', { tag: 'お知らせ', title: 'N-通常新しい', date: today });
    await api('POST', '/api/admin/news', { tag: 'お知らせ', title: 'N-通常古い', date: addDays(-20), expires: addDays(30) });
    await api('POST', '/api/admin/news', { tag: '重要', title: 'N-重要', date: addDays(-10), expires: addDays(30) });
    await api('POST', '/api/admin/news', { tag: 'お知らせ', title: 'N-固定', date: addDays(-15), expires: addDays(30), pinned: '1' });
    await api('POST', '/api/admin/news', { tag: 'お知らせ', title: 'N-期限切れ', date: addDays(-40), expires: addDays(-5) });
    await br.open(`${sb.base}/index.html`, 1280, 900, "document.querySelectorAll('#news-list [data-news]').length > 0");
    const rows = JSON.parse(await br.evaluate("JSON.stringify([...document.querySelectorAll('#news-list [data-news]')].map(b => b.textContent.replace(/\\s+/g, ' ').trim()))"));
    const titles = rows.map(r => (r.match(/N-[ぁ-んァ-ヶ一-龠]+/) || [''])[0]);
    check('お知らせ: 期限切れはトップに出ない', !titles.includes('N-期限切れ'), titles.join());
    check('お知らせ: 重要・固定が先頭の2件', new Set(titles.slice(0, 2)).size === 2 && titles.slice(0, 2).every(t => t === 'N-重要' || t === 'N-固定'), titles.join());
    check('お知らせ: その後は掲載日の新しい順', titles.slice(2).join() === 'N-通常新しい,N-通常古い', titles.join());
    check('お知らせ: NEWは掲載7日以内だけ', rows.filter(r => r.includes('NEW')).length === 1 && rows.find(r => r.includes('N-通常新しい')).includes('NEW'), rows.join(' | '));

    // ---- システム案内(案B・案C。枠組み): トップのメニューにリンクがあり、ページが動く ----
    await br.open(`${sb.base}/index.html`, 1280);
    check('トップのメニューに「システム案内B」「システム案内C」がある', await br.evaluate("['system-guide-b.html', 'system-guide-c.html'].every(h => !!document.querySelector('header a[href=\"' + h + '\"]'))"));
    // 案B: 記事がまだ無い間は、仮の記事(プレビュー)を表示する
    await br.open(`${sb.base}/system-guide-b.html`, 1280, 900, "document.querySelectorAll('#gb-cats [data-cat]').length > 0");
    check('案B: 記事が無い間は、仮の記事(プレビュー)と案内を表示する', await br.evaluate("document.getElementById('gb-preview').style.display !== 'none' && document.querySelectorAll('#gb-list [data-article]').length > 0"));
    // 案B: 記事と添付(PDF)を登録 → DBの記事を表示・添付の中の文字で検索できる
    const mkG = async o => (await api('POST', '/api/admin/guide', o)).id;
    const gA = await mkG({ cat: 'network', kind: '手順', title: '社外から使う方法', body: '手順の説明', popular: '1' });
    const gB = await mkG({ cat: 'jinjer', kind: 'FAQ', title: '打刻の直し方', body: '打刻を修正したいとき' });
    const gC = await mkG({ cat: 'jinjer', kind: '申請', title: '休暇の申請方法', body: '申請の手順' });
    const upRes = await fetch(`${sb.base}/api/attachments?kind=guide&itemId=${gA}&name=${encodeURIComponent('VPNマニュアル.pdf')}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: fs.readFileSync(path.join(__dirname, 'fixtures', 'manual-ja.pdf')) });
    check('案B: 記事にPDFを添付できる', upRes.status === 200);
    await br.open(`${sb.base}/system-guide-b.html`, 1280, 900, "document.querySelectorAll('#gb-cats [data-cat]').length > 0 && document.getElementById('gb-preview').style.display === 'none'");
    check('案B: 登録した記事を表示し、仮の記事の案内は出ない・初期表示は「よくある困りごと」', await br.evaluate("document.getElementById('gb-preview').style.display === 'none' && document.querySelectorAll('#gb-cats [data-cat]').length === 5 && document.getElementById('gb-list-title').textContent === 'よくある困りごと' && document.querySelectorAll('#gb-list [data-article]').length === 1"));
    await br.evaluate("document.querySelector('#gb-cats [data-cat=jinjer]').click()");
    check('案B: 分野を押すと、その分野の記事だけに絞られる', await br.evaluate("document.getElementById('gb-list-title').textContent.includes('jinjer') && document.querySelectorAll('#gb-list [data-article]').length === 2"));
    await br.evaluate("document.querySelector('#gb-list [data-article]').click()");
    check('案B: 記事を押すと本文が開く', await br.evaluate("document.getElementById('gb-article').style.display !== 'none' && document.querySelector('#gb-article h2').textContent.length > 0"));
    await br.evaluate("(() => { const s = document.getElementById('gb-search'); s.value = '多要素認証'; s.dispatchEvent(new Event('input')); })()");
    await br.open(`${sb.base}/system-guide-b.html`, 1280, 900, "document.querySelectorAll('#gb-cats [data-cat]').length > 0"); // 画面を開き直して、検索欄の動きを別に確認
    await br.evaluate("(() => { const s = document.getElementById('gb-search'); s.value = '多要素認証'; s.dispatchEvent(new Event('input')); })()");
    await sleep(1200); // 入力から検索までの待ち(0.25秒)+サーバーの応答
    check('案B: 検索で、添付PDFの中の文字が見つかり、該当する添付と抜粋が出る', await br.evaluate("document.querySelectorAll('#gb-list [data-article]').length === 1 && document.getElementById('gb-list').textContent.includes('VPNマニュアル.pdf') && document.getElementById('gb-list').textContent.includes('多要素認証')"));
    await br.evaluate("document.querySelector('#gb-list [data-article]').click()");
    check('案B: 記事に添付ファイルのダウンロードボタンがある', await br.evaluate("document.querySelectorAll('#gb-article [data-dl]').length === 1 && document.getElementById('gb-article').textContent.includes('VPNマニュアル.pdf')"));
    await br.evaluate("(() => { const s = document.getElementById('gb-search'); s.value = '存在しない言葉'; s.dispatchEvent(new Event('input')); })()");
    await sleep(1000);
    check('案B: 該当なしの表示', await br.evaluate("document.getElementById('gb-list').textContent.includes('該当する記事はありません')"));
    await br.open(`${sb.base}/system-guide-c.html`, 1280, 900, "document.querySelectorAll('#gc-cats section').length > 0");
    check('案C: 分野のカードが5つ・リンク未設定は「準備中」', await br.evaluate("document.querySelectorAll('#gc-cats section').length === 5 && document.getElementById('gc-cats').textContent.includes('準備中')"));
    check('案C: 外部リンクは新しいタブで開く', await br.evaluate("[...document.querySelectorAll('#gc-cats a[href^=https]')].every(a => a.target === '_blank' && a.rel.includes('noopener'))"));

    // ---- 組織図(枠組み): メニューにあり、部門の列・階層の枠が描ける(devモードは社員名簿の取得ができないため、疑似データを渡して描く) ----
    await br.open(`${sb.base}/index.html`, 1280);
    check('トップのメニューに「組織図」がある', await br.evaluate("!!document.querySelector('header a[href=\"organization-chart.html\"]')"));
    await br.open(`${sb.base}/organization-chart.html`, 1280);
    await br.evaluate(`(() => {
      const P = (name, email, title, empType) => ({ name, email, title: title || '', empType: empType || '', phone: '' });
      const org = { left: [{ dept: '会長', members: [P('友藤 昭弘', 'a@x.com', '', '1')] }, { dept: '社長', members: [P('友藤 忠昭', 'b@x.com', '', '1')] }, { dept: '専務', members: [P('東 伸考', 'c@x.com', '', '2')] },
        { dept: '総務部', members: [P('部長 一', 'd@x.com', '部長', '3'), P('課長 二', 'e@x.com'), P('一般 三', 'f@x.com')] }], right: [], names: {} };
      renderOrgChart(buildOrgChart(org, [{ email: 'e@x.com', dept: '', title: '課長', sort: 0 }]));
    })()`);
    check('組織図: 部門の列が9つ・①会長社長/②専務の枠・③部長・⑤課長が描かれる', await br.evaluate("document.querySelectorAll('.oc-col').length === 9 && document.querySelector('.oc-l1').textContent.includes('友藤 昭弘') && document.querySelector('.oc-l1').textContent.includes('友藤 忠昭') && document.querySelector('.oc-l2').textContent.includes('東 伸考') && document.querySelector('.oc-l3').textContent.includes('部長 一') && document.querySelector('.oc-m .oc-title').textContent === '課長'"));
    await br.evaluate(`(() => {
      const P = (name, email, title, empType) => ({ name, email, title: title || '', empType: empType || '', phone: '' });
      const org = { left: [{ dept: '専務取締役', members: [P('東 伸考', 'c@x.com', '専務取締役', '2')] }, { dept: '工務部(本社)', members: [P('本社 一', 'h1@x.com')] }, { dept: '工務部(平野)', members: [P('平野 一', 'h2@x.com')] }, { dept: '工務部(西宮)', members: [P('西宮 一', 'h3@x.com')] }], right: [], names: {} };
      renderOrgChart(buildOrgChart(org, []));
    })()`);
    check('組織図: 専務取締役が②の枠に出る', await br.evaluate("document.querySelector('.oc-l2') && document.querySelector('.oc-l2').textContent.includes('東 伸考')"));
    check('組織図: 工務部の小区分(本社・平野・西宮)は横に並ぶ(縦に積まない)', await br.evaluate("(() => { const s = [...document.querySelectorAll('.oc-col')].find(c => c.textContent.includes('工務部')).querySelectorAll('.oc-section'); return s.length === 3 && s[0].getBoundingClientRect().top === s[1].getBoundingClientRect().top && s[1].getBoundingClientRect().left > s[0].getBoundingClientRect().left; })()"));
    check('組織図: ゆめすみかの展示場などは、すべての列の下の段に、横に並べて置く(他の部門の人の一覧にかぶらない)', await br.evaluate("(() => { const P = (n, e) => ({ name: n, email: e, title: '', empType: '', phone: '' }); renderOrgChart(buildOrgChart({ left: [{ dept: '購買部', members: [P('甲 一', 'k1@x.com'), P('甲 二', 'k2@x.com'), P('甲 三', 'k3@x.com'), P('甲 四', 'k4@x.com'), P('甲 五', 'k5@x.com')] }], right: [{ dept: '福田展示場', members: [P('A 一', 'a@y.com')] }, { dept: '中百舌鳥展示場', members: [P('B 二', 'b@y.com')] }], names: {} }, [])); const tier = document.querySelector('.oc-tier'); const s = tier.querySelectorAll('.oc-section'); const colsBottom = Math.max(...[...document.querySelectorAll('.oc-col')].map(c => c.getBoundingClientRect().bottom)); return !!tier && s.length === 2 && s[0].getBoundingClientRect().top === s[1].getBoundingClientRect().top && tier.getBoundingClientRect().top >= colsBottom - 1 && !document.querySelector('.oc-col.oc-tier-link .oc-members'); })()"));
    // カスタマーサポート室の左の線(spine)に、事業係などを縦に並べる(横に長くしない)
    check('組織図: 事業係などは、それぞれ独立した枠で、間をあけて横に並ぶ(下の段。列は増えない)', await br.evaluate("(() => { const P = (n, e) => ({ name: n, email: e, title: '', empType: '', phone: '' }); renderOrgChart(buildOrgChart({ left: [{ dept: 'カスタマーサポート室', members: [P('CS 一', 'c1@x.com')] }, { dept: 'エクステリア事業係', members: [P('外 一', 'e1@x.com')] }, { dept: '物流事業係', members: [P('物 一', 'l1@x.com')] }], right: [], names: {} }, [])); const first = document.querySelector('.oc-col'); const sec = [...document.querySelectorAll('.oc-tier[data-kind=side]')]; const colsBottom = Math.max(...[...document.querySelectorAll('.oc-col')].map(c => c.getBoundingClientRect().bottom)); const r0 = sec[0].getBoundingClientRect(), r1 = sec[1].getBoundingClientRect(); return first.classList.contains('oc-has-side') && !!first.querySelector('.oc-spine') && sec.length === 2 && r0.top === r1.top && r1.left >= r0.right + 10 && r0.top >= colsBottom - 1 && sec[0].querySelector('.oc-tier-title').textContent === 'エクステリア事業係' && document.querySelectorAll('.oc-col').length === 9; })()"));
    // 工務事務の箱: カスタマーサポート室・リフォーム部・工務部の下に置き、3部門と実線でつなぐ。人は2行に均等に並べる
    check('組織図: 工務事務の箱は、人数に合わせた大きさで、最大2列。3部門の下に出て実線でつながり、事業係などの行は、その下に回って線とかぶらない', await br.evaluate("(() => { const P = (n, e, t) => ({ name: n, email: e, title: t || '', empType: '', phone: '' }); renderOrgChart(buildOrgChart({ left: [{ dept: 'カスタマーサポート室', members: [P('CS 一', 'c1@x.com'), P('事 一', 'j1@x.com', '工務事務'), P('事 二', 'j2@x.com', '工務事務')] }, { dept: 'リフォーム部', members: [P('リ 一', 'r1@x.com'), P('事 三', 'j3@x.com', '工務事務')] }, { dept: '工務部(本社)', members: [P('工 一', 'k1@x.com'), P('事 四', 'j4@x.com', '工務事務'), P('事 五', 'j5@x.com', '工務事務')] }, { dept: 'エクステリア事業係', members: [P('外 一', 'e1@x.com')] }], right: [], names: {} }, [])); const t = document.querySelector('.oc-jimu'); const it = [...t.querySelectorAll('.oc-jm')]; const colsBottom = Math.max(...[...document.querySelectorAll('.oc-col')].map(c => c.getBoundingClientRect().bottom)); const lines = document.querySelectorAll('.oc-jline').length; const side = document.querySelector('.oc-tier[data-kind=side]'); const tr = t.getBoundingClientRect(); const span = document.querySelectorAll('.oc-col')[2].getBoundingClientRect().right - document.querySelectorAll('.oc-col')[0].getBoundingClientRect().left; return !!t && it.length === 5 && it[0].getBoundingClientRect().left === it[1].getBoundingClientRect().left && it[0].getBoundingClientRect().left === it[2].getBoundingClientRect().left && it[3].getBoundingClientRect().left > it[0].getBoundingClientRect().left && it[3].getBoundingClientRect().top === it[0].getBoundingClientRect().top && it[4].getBoundingClientRect().top > it[3].getBoundingClientRect().top && tr.width < span * 0.7 && tr.top > colsBottom && lines === 5 && side.getBoundingClientRect().top >= tr.bottom + 20 && ![...document.querySelectorAll('.oc-col .oc-m')].some(e => e.textContent.includes('事 ')); })()"));
    check('組織図: 工務事務が1人だけのときは1列(枠が小さい)', await br.evaluate("(() => { const P = (n, e, t) => ({ name: n, email: e, title: t || '', empType: '', phone: '' }); renderOrgChart(buildOrgChart({ left: [{ dept: 'カスタマーサポート室', members: [P('CS 一', 'c1@x.com'), P('事 一', 'j1@x.com', '工務事務')] }], right: [], names: {} }, [])); const t = document.querySelector('.oc-jimu'); return t.querySelectorAll('.oc-jm').length === 1 && t.getBoundingClientRect().width < 260; })()"));
    check('組織図: 画面の幅(1280px)でもページが横にはみ出さない(図の中だけスクロール)', await br.evaluate(noOverflow));
    check('組織図: 印刷用の設定(A3横)がある', await br.evaluate("[...document.styleSheets].some(ss => { try { return [...ss.cssRules].some(r => r.cssText.includes('A3') || r.cssText.includes('a3')); } catch { return false; } })"));
    // 2026-10-22: 印刷で線が消えない設定・マネージャーの箱から下の段への線が途切れない・役職と名前が列ごとに中央揃え
    check('組織図: 印刷(PDF)でも線と箱の色が消えない設定(print-color-adjust: exact)が、図の全要素にある', await br.evaluate("getComputedStyle(document.querySelector('.oc-spine') || document.querySelector('.oc-dept')).printColorAdjust === 'exact' && [...document.querySelectorAll('.oc-col')].every(c => getComputedStyle(c, '::before').printColorAdjust === 'exact')"));
    check('組織図: ゆめすみかの下の段へ、元の部門の下の線が途切れずにつながる(線の下端が下の段の上端に届く)', await br.evaluate("(() => { let n = 0; const P = (name, title, t) => ({ name, email: 'q' + (++n) + '@x.com', title: title || '', empType: t || '', phone: '' }); renderOrgChart(buildOrgChart({ left: [], right: [{ dept: 'マネージャー', members: [P('大平', 'マネージャー', '2')] }, { dept: '福田展示場', members: [P('福一'), P('福二')] }, { dept: '設計', members: [P('設一')] }], names: {} }, [])); const drop = document.querySelector('.oc-dropline'), tier = document.querySelector('.oc-tier[data-kind=lower]'); if (!drop || !tier) return false; const d = drop.getBoundingClientRect(), t = tier.getBoundingClientRect(); const e = drop.querySelector('.oc-dropline-ext'); if (!e) return false; const l = e.getBoundingClientRect(); return Math.abs(l.top - d.bottom) < 1 && l.bottom >= t.top - 1 && Math.abs(l.left - d.left) < 0.6 && Math.abs(l.right - d.right) < 0.6; })()"));
    check('組織図: ⑤の一覧は、役職の列・名前の列とも中央揃え', await br.evaluate("(() => { renderOrgChart(buildOrgChart({ left: [{ dept: '購買部', members: [{ name: '甲 一', email: 'z1@x.com', title: '部長', empType: '3', phone: '' }, { name: '乙 二', email: 'z2@x.com', title: '主任', empType: '', phone: '' }, { name: '丙 三', email: 'z3@x.com', title: '', empType: '', phone: '' }] }], right: [], names: {} }, [{ email: 'z2@x.com', dept: '', title: '主任', sort: 0 }])); const t = document.querySelector('.oc-members .oc-title'), n = document.querySelector('.oc-members .oc-name'); return !!t && getComputedStyle(t).textAlign === 'center' && getComputedStyle(n).textAlign === 'center'; })()"));
    // 印刷ボタン(beforeprint)で縮小(zoom)しても、事業係などの下の段の枠が重ならない(zoom中に位置を計算すると崩れた。2026-10-22・ユーザー指摘)
    check('組織図: 印刷時(beforeprint)に縮小しても、下の段の枠(事業係など・工務事務・ゆめすみか)が重ならない。印刷後は元に戻る', await br.evaluate("(() => { let n = 0; const P = (name, title) => ({ name, email: 'pp' + (++n) + '@x.com', title: title || '', empType: '', phone: '' }); const mk = (pre, c) => Array.from({ length: c }, (_, i) => P(pre + i)); renderOrgChart(buildOrgChart({ left: [{ dept: 'カスタマーサポート室', members: [...mk('C', 6), P('事務', '工務事務')] }, { dept: 'リフォーム部', members: mk('R', 4) }, { dept: 'エクステリア事業係', members: mk('E', 5) }, { dept: '来夢エンジニア', members: mk('K', 4) }, { dept: '物流事業係', members: mk('B', 3) }, { dept: 'フレミング大工', members: mk('F', 7) }, { dept: '購買部', members: mk('G', 4) }, { dept: '不動産部', members: mk('U', 4) }, { dept: '建築営業部', members: mk('V', 8) }, { dept: '設計企画部', members: mk('W', 5) }, { dept: '総務部', members: mk('X', 4) }], right: [{ dept: '福田展示場', members: mk('H', 4) }, { dept: '中百舌鳥展示場', members: mk('H2', 4) }, { dept: '平野展示場', members: mk('H3', 4) }, { dept: '花博展示場', members: mk('H4', 4) }, { dept: '西宮展示場', members: mk('H5', 4) }, { dept: '設計', members: mk('S', 3) }, { dept: '広報企画室', members: mk('M', 3) }], names: {} }, [])); window.dispatchEvent(new Event('beforeprint')); const z = Number(document.getElementById('oc-chart').style.zoom); const R = [...document.querySelectorAll('.oc-tier')].map(t => t.getBoundingClientRect()); let ov = 0; for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) { const a = R[i], b = R[j]; if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) ov++; } window.dispatchEvent(new Event('afterprint')); return R.length >= 4 && z > 0 && z < 1 && ov === 0 && document.getElementById('oc-chart').style.zoom === ''; })()"));

    // ---- 週の予定(スケジュール画面) ----
    await br.open(`${sb.base}/schedule.html`, 1280, 900, "document.querySelectorAll('#week-events [data-week-day]').length === 7");
    const week = JSON.parse(await br.evaluate("JSON.stringify({ n: document.querySelectorAll('#week-events [data-week-day]').length, first: document.querySelector('#week-events [data-week-day]')?.textContent.trim().slice(0, 12), title: document.getElementById('week-title')?.textContent })"));
    check('週の予定: 日〜土の7行が出る', week.n === 7, JSON.stringify(week));
    check('週の予定: 1行目は日曜', /\(日\)/.test(week.first || ''), week.first);
    check('週の予定: 見出しが「今週の予定」', /^今週の予定/.test(week.title || ''), week.title);

    // ---- スタッフ予定: タブ(吉村一建設は2行固定) ----
    await br.open(`${sb.base}/yoshimuraichi-schedule.html`, 1280, 900, "document.querySelectorAll('#group-tabs > div').length > 0");
    const tabRows = JSON.parse(await br.evaluate("JSON.stringify([...document.querySelectorAll('#group-tabs > div')].map(r => [...r.querySelectorAll('button')].map(b => b.textContent.trim())))"));
    check('吉村一建設スタッフ予定: タブは2行', tabRows.length === 2, JSON.stringify(tabRows));
    check('吉村一建設スタッフ予定: 大工のタブは出さない', !tabRows.flat().some(t => t.includes('大工')), JSON.stringify(tabRows));
    check('吉村一建設スタッフ予定: 見出しに並び順の注記', await br.evaluate("document.body.textContent.includes('五十音順')"));

    // ---- 社員名簿の「出勤状況」ボタン: キー未設定では出さない ----
    await br.open(`${sb.base}/organization.html`, 1280);
    check('社員名簿: 出勤状況ボタンは、キー未設定では表示されない', await br.evaluate("(() => { const a = document.querySelector('[data-feature=attendance]'); return !!a && a.offsetParent === null; })()"));

    // ---- 通信の失敗・無応答でも画面が表示される(P004) ----
    await br.setPreScript("(() => { const f = window.fetch; window.fetch = (u, o) => String(u).includes('/api/me') ? Promise.reject(new TypeError('Failed to fetch')) : f(u, o); })();");
    check('/api/me が失敗しても画面は表示される', await br.open(`${sb.base}/index.html`, 1280, 900, null, 8000));
    await br.setPreScript("(() => { const f = window.fetch; window.fetch = (u, o) => String(u).includes('/api/me') ? new Promise(() => {}) : f(u, o); })();");
    check('/api/me が無応答でも約10秒以内に画面が表示される', await br.open(`${sb.base}/index.html`, 1280, 900, null, 14000));
    await br.setPreScript(null);

    // ---- jinjerキーがある環境(ダミー)では、出勤状況のページとボタンが出る ----
    const sbk = await startSandbox({ JINJER_API_KEY: 'dummy', JINJER_SECRET_KEY: 'dummy' });
    try {
      for (const w of [1280, 390]) {
        const shown = await br.open(`${sbk.base}/attendance.html`, w);
        check(`attendance.html (${w}px): キーありでは表示される`, shown);
        if (shown) { await sleep(500); check(`attendance.html (${w}px): 横にはみ出さない`, await br.evaluate(noOverflow)); }
      }
      // 「最新の情報に更新」を押しても、jinjerを呼ぶ取り込みAPIは使わず、保存済みデータの読み直し(GET)だけ
      await br.setPreScript("window.__calls = []; (() => { const f = window.fetch; window.fetch = (u, o) => { window.__calls.push((o && o.method || 'GET') + ' ' + String(u)); return f(u, o); }; })();");
      await br.open(`${sbk.base}/attendance.html`, 1280);
      await br.evaluate("document.getElementById('att-sync').click()");
      await sleep(800);
      const calls = JSON.parse(await br.evaluate('JSON.stringify(window.__calls)'));
      check('出勤状況: 更新ボタンは取り込みAPIを呼ばない', !calls.some(c => c.includes('/sync')) && calls.filter(c => c === 'GET /api/attendance').length >= 2, JSON.stringify(calls));
      await br.setPreScript(null);
      await br.open(`${sbk.base}/organization.html`, 1280);
      check('社員名簿: キーありでは出勤状況ボタンが右上に表示される', await br.evaluate("(() => { const a = document.querySelector('[data-feature=attendance]'); return !!a && a.offsetParent !== null && a.getBoundingClientRect().right > innerWidth - 100; })()"));
    } finally { await sbk.stop(); }
  } finally {
    await br.close();
    await sb.stop();
  }
  process.exit(done() ? 1 : 0);
})().catch(e => { console.error('TEST ERROR', e); process.exit(2); });
