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
    const pages = fs.readdirSync(path.join(ROOT, 'public')).filter(f => f.endsWith('.html') && f !== 'igrace-login.html').sort();
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

    // ---- 通信の失敗・無応答でも画面が表示される(P004) ----
    await br.setPreScript("(() => { const f = window.fetch; window.fetch = (u, o) => String(u).includes('/api/me') ? Promise.reject(new TypeError('Failed to fetch')) : f(u, o); })();");
    check('/api/me が失敗しても画面は表示される', await br.open(`${sb.base}/index.html`, 1280, 900, null, 8000));
    await br.setPreScript("(() => { const f = window.fetch; window.fetch = (u, o) => String(u).includes('/api/me') ? new Promise(() => {}) : f(u, o); })();");
    check('/api/me が無応答でも約10秒以内に画面が表示される', await br.open(`${sb.base}/index.html`, 1280, 900, null, 14000));
    await br.setPreScript(null);
  } finally {
    await br.close();
    await sb.stop();
  }
  process.exit(done() ? 1 : 0);
})().catch(e => { console.error('TEST ERROR', e); process.exit(2); });
