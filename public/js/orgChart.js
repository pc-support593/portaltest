// 組織図(2026-10-20・ユーザー依頼。テスト環境のみ・枠組みの試作)。
// 枠組みは manual/template/組織図.xlsx を元にしたコード内の定数(ORG_CHART_FRAME)。人は既存の社員名簿のデータ(orgData.js の loadOrgData=
// MS365のグループ・役職・従業員の種類)から自動で入れる。MS365に無い「課長以下の役職」と「兼任」は、管理画面の「組織図の役職」で手入力する(orgchart_titles)。
// 階層は、MS365の「従業員の種類」の数字で決める(2026-10-20・ユーザーが整理): 1=①会長・社長 2=②専務取締役 3=③室長・マネージャー・部長(取締役部長を含む) 4=④次長 記載なし=⑤課長を含むメンバー。
// ゆめすみかは例外で、1=③常務取締役 2=④マネージャー。⑤の役職は手入力。
'use strict';

// 枠組み(部門の並びと、社員名簿のどのグループを入れるか)。Excelの組織図の並びに合わせる。groups は社員名簿の見出し(グループ名)
const ORG_CHART_FRAME = {
  top: { l1: ['会長', '社長'], l2: ['専務'] }, // 社員名簿の左列の見出し(従業員の種類=1の人の役職)
  columns: [
    { name: 'カスタマーサポート室', side: 'left', sections: [{ label: '', groups: ['カスタマーサポート室'] }] },
    { name: 'リフォーム部', side: 'left', sections: [{ label: '', groups: ['リフォーム部'] }] },
    {
      name: '工務部', side: 'left', sections: [
        { label: '本社', groups: ['工務部(本社)'] }, { label: '平野', groups: ['工務部(平野)'] }, { label: '西宮', groups: ['工務部(西宮)'] },
        { label: 'エクステリア事業係', groups: ['エクステリア事業係'] }, { label: '物流事業係', groups: ['物流事業係'] },
        { label: 'フレミング大工', groups: ['フレミング大工'] }, { label: '㈱来夢エンジニア', groups: ['来夢エンジニア'] }
      ]
    },
    { name: '購買部', side: 'left', sections: [{ label: '', groups: ['購買部'] }] },
    { name: '不動産部', side: 'left', sections: [{ label: '', groups: ['不動産部'] }] },
    {
      name: '㈱ゆめすみか', side: 'right', l3Group: 'ゆめすみか常務取締役', l4Group: 'マネージャー', stack: true, sections: [ // stack: 展示場などを下に積む(横幅を広げない。2026-10-20・ユーザー指示)
        { label: '福田展示場', groups: ['福田展示場'] }, { label: '中百舌鳥展示場', groups: ['中百舌鳥展示場'] }, { label: '平野展示場', groups: ['平野展示場'] },
        { label: '花博展示場', groups: ['花博展示場'] }, { label: '西宮展示場', groups: ['西宮展示場'] }, { label: '設計', groups: ['設計'] }
      ]
    },
    { name: '建築営業部', side: 'left', sections: [{ label: '', groups: ['建築営業部'] }] },
    { name: '設計企画部', side: 'left', sections: [{ label: '', groups: ['設計企画部'] }] },
    { name: '総務部', side: 'left', sections: [{ label: '', groups: ['総務部'] }] }
  ]
};

// ③(室長・マネージャー・部長・取締役部長)と④(次長)の判定。役職の先頭が一致するか(「次長(兼任)」も次長)
const ORG_L3_TITLE = ['取締役部長', '部長', '室長', 'マネージャー'];
const ORG_L4_TITLE = ['次長'];
// ⑤の表示順(役職の先頭が一致。上にあるほど上位。ここに無い役職は後ろ、役職なしは最後)
const ORG_L5_RANK = ['課長', '店長', '係長', '店長代理', '主任', 'リーダー'];

// 役職が一覧のどれかと一致するか。完全一致、または「次長(兼任)」「部長(兼)」のように丸括弧の注記つき(「部長代理」「マネージャー補佐」などは別の役職なので含めない)
const orgStartsWith = (title, list) => list.some(t => { const s = String(title || ''); return s === t || s.startsWith(t + '(') || s.startsWith(t + '（'); });
const orgNorm = s => String(s || '').normalize('NFKC').replace(/\s+/g, ''); // サーバー(server.js の normalizeOrgKey)と同じ規則
const orgKeyOf = m => (m.email ? m.email.toLowerCase() : 'name:' + orgNorm(m.name)); // メールの無い手動メンバーは 'name:氏名' で区別する

function orgRank(title) {
  const t = String(title || '');
  if (!t) return ORG_L5_RANK.length + 1;
  // 一致する中で一番長い名前を採る(「店長代理」が「店長」に先に当たらないように)
  let best = -1;
  ORG_L5_RANK.forEach((r, i) => { if (t.startsWith(r) && (best < 0 || r.length > ORG_L5_RANK[best].length)) best = i; });
  return best >= 0 ? best : ORG_L5_RANK.length;
}

/** 組織図の中身を組み立てる(純粋な関数)。
    org: loadOrgData() の結果 { left:[{dept,members}], right:[...], names:{email→氏名} }
    manual: [{ email, dept, title, sort }](orgchart_titles。dept='' はその人の既定の役職、dept=部門名はその部門だけ)
    戻り値: { l1:[{name,title}], l2:[...], columns:[{ name, l3:[{name,title}], l4:[...], sections:[{ label, members:[{name,title,key,added}] }] }] } */
function buildOrgChart(org, manual) {
  const left = (org && org.left) || [], right = (org && org.right) || [];
  const names = (org && org.names) || {};
  const man = new Map();
  (manual || []).forEach(r => man.set(`${String(r.email).toLowerCase()}|${r.dept || ''}`, r));
  const dispName = m => displayName(m.name || '');
  const groupMembers = (groups, label) => ((groups.find(g => g.dept === label) || {}).members) || [];
  const empOf = m => String(m.empType == null ? '' : m.empType).trim(); // 従業員の種類(MS365の employeeType)

  // 階層は「従業員の種類」の数字で決める(2026-10-20・ユーザーが整理)。
  //   吉村一建設側: 1=①会長・社長 / 2=②専務取締役 / 3=③室長・マネージャー・部長(取締役部長を含む) / 4=④次長 / 記載なし=⑤
  //   ゆめすみか側(例外): 1=③常務取締役 / 2=④マネージャー / それ以外=⑤
  // ①②は、どの部門のグループに入っている人でも拾い、部門の列には重ねて出さない(同じ人が複数のグループにいる場合は1回だけ)
  const topCand = [];
  left.forEach(g => g.members.forEach(m => topCand.push({ m, title: m.title || g.dept })));
  const pickTop = emp => {
    const seenTop = new Set();
    return topCand.filter(c => empOf(c.m) === emp).filter(c => { const k = orgKeyOf(c.m); if (seenTop.has(k)) return false; seenTop.add(k); return true; });
  };
  const l1c = pickTop('1').sort((a, b) => (String(b.title).includes('会長') ? 1 : 0) - (String(a.title).includes('会長') ? 1 : 0)); // 会長を先に
  const l2c = pickTop('2');
  const topKeys = new Set([...l1c, ...l2c].map(c => orgKeyOf(c.m)));
  const chart = { l1: l1c.map(c => ({ name: dispName(c.m), title: c.title })), l2: l2c.map(c => ({ name: dispName(c.m), title: c.title })), columns: [] };

  for (const col of ORG_CHART_FRAME.columns) {
    const isRight = col.side === 'right';
    const pool = isRight ? right : left;
    const effTitle = m => {
      const k = orgKeyOf(m);
      // 優先順: ①この部門を指定した手入力(兼任など) ②MS365の役職 ③部門を問わない手入力の既定(MS365に役職が無い人)
      const hit = man.get(`${k}|${col.name}`);
      if (hit) return hit.title;
      if (m.title) return m.title;
      const def = man.get(`${k}|`);
      return def ? def.title : '';
    };
    const item = (m, extra) => ({ name: dispName(m), title: effTitle(m), key: orgKeyOf(m), ...extra });
    const out = { name: col.name, l3: [], l4: [], sections: [] };
    const seen = new Set(topKeys); // 同じ人を、同じ部門の中で二重に出さない(①②の人は部門の列には出さない)
    const take = (m, list, fallbackTitle) => {
      const k = orgKeyOf(m);
      if (seen.has(k)) return;
      seen.add(k);
      list.push({ ...item(m), title: effTitle(m) || fallbackTitle });
    };

    if (isRight) {
      // ゆめすみか: 従業員の種類 1=③常務取締役・2=④マネージャー(どのグループにいても拾う)。種類を付ける前の運用に備え、従来の見出し(PERSON_OVERRIDES)の人も同じ枠に載せる
      right.forEach(g => g.members.forEach(m => { if (empOf(m) === '1') take(m, out.l3, '常務取締役'); }));
      if (col.l3Group) groupMembers(pool, col.l3Group).forEach(m => take(m, out.l3, '常務取締役'));
      right.forEach(g => g.members.forEach(m => { if (empOf(m) === '2') take(m, out.l4, 'マネージャー'); }));
      if (col.l4Group) groupMembers(pool, col.l4Group).forEach(m => take(m, out.l4, 'マネージャー'));
    }

    col.sections.forEach(sec => {
      const members = [];
      sec.groups.forEach(g => groupMembers(pool, g).forEach(m => {
        const k = orgKeyOf(m);
        if (seen.has(k)) return;
        seen.add(k);
        const it = item(m);
        const emp = empOf(m);
        if (!isRight && emp === '3') out.l3.push(it);
        else if (!isRight && emp === '4') out.l4.push(it);
        else members.push(it);
      }));
      out.sections.push({ label: sec.label, members });
    });

    // 兼任・追加: この部門を指定した手入力の行のうち、まだ載っていない人を足す(MS365のグループに入っていない人)。
    // 手入力の行には従業員の種類が無いので、役職の文字(「次長」「部長」など。括弧の注記つきも可)で③④を判定する(ゆめすみかの列は⑤)
    (manual || []).filter(r => r.dept === col.name).forEach(r => {
      const k = String(r.email).toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      const nm = names[k] || (k.startsWith('name:') ? k.slice(5) : k);
      const it = { name: displayName(nm), title: r.title, key: k, added: true };
      if (!isRight && orgStartsWith(it.title, ORG_L3_TITLE)) out.l3.push(it);
      else if (!isRight && orgStartsWith(it.title, ORG_L4_TITLE)) out.l4.push(it);
      else if (out.sections.length) out.sections[0].members.push(it);
    });

    // ⑤の並び: 役職の順(課長→店長→係長…)→手入力の順(sort)→名簿の順(元の並びのまま)
    out.sections.forEach(sec => {
      sec.members = sec.members.map((m, i) => ({ m, i }))
        .sort((a, b) => orgRank(a.m.title) - orgRank(b.m.title) || sortOf(a.m) - sortOf(b.m) || a.i - b.i).map(x => x.m);
    });
    function sortOf(m) { const r = man.get(`${m.key}|${col.name}`) || man.get(`${m.key}|`); return r ? Number(r.sort) || 0 : 0; }
    chart.columns.push(out);
  }
  return chart;
}

/** 管理画面「組織図の役職」用: 枠組みの各部門に入る人(⑤になる人を中心に)の一覧。役職の手入力の欄を出すためのもの */
function orgChartPeopleForAdmin(org, manual) {
  const chart = buildOrgChart(org, manual);
  const rows = [];
  chart.columns.forEach(col => {
    col.sections.forEach(sec => sec.members.forEach(m => rows.push({ dept: col.name, section: sec.label, key: m.key, name: m.name, title: m.title, added: !!m.added })));
  });
  return rows;
}

// ---- 画面(organization-chart.html) ----
const ocEl = id => document.getElementById(id);

function ocPersonHtml(p, cls) {
  return `<div class="${cls}"><span class="oc-title">${esc(p.title || '')}</span><span class="oc-name">${esc(p.name)}</span></div>`;
}

function renderOrgChart(chart) {
  const box = (items, cls) => items.length ? `<div class="oc-box ${cls}">${items.map(p => ocPersonHtml(p, 'oc-p')).join('')}</div>` : '';
  const topHtml = `
    <div class="oc-top">
      ${box(chart.l1, 'oc-l1')}
      ${chart.l1.length && chart.l2.length ? '<div class="oc-vline"></div>' : ''}
      ${box(chart.l2, 'oc-l2')}
      ${chart.l2.length ? '<div class="oc-vline"></div>' : ''}
    </div>`;
  const colsHtml = chart.columns.map(col => {
    const secs = col.sections.filter(s => s.members.length);
    const stack = ORG_CHART_FRAME.columns.find(c => c.name === col.name)?.stack; // 枠組みの設定(stack=縦に積む)
    return `
    <div class="oc-col">
      <div class="oc-dept">${esc(col.name)}</div>
      ${box(col.l3, 'oc-l3')}
      ${col.l3.length && col.l4.length ? '<div class="oc-vline oc-short"></div>' : ''}
      ${box(col.l4, 'oc-l4')}
      ${secs.length ? `<div class="oc-members${stack ? ' oc-stack' : ''}">
        ${secs.map(s => `
        <div class="oc-section">
          ${s.label ? `<div class="oc-section-label">${esc(s.label)}</div>` : ''}
          ${s.members.map(m => ocPersonHtml(m, 'oc-m' + (m.added ? ' oc-added' : ''))).join('')}
        </div>`).join('')}
      </div>` : ''}
    </div>`;
  }).join('');
  ocEl('oc-chart').innerHTML = `${topHtml}<div class="oc-cols">${colsHtml}</div>`;
}

/** 印刷(PDF保存)用: 図の幅をA3横の用紙の幅に合わせて縮小する(印刷の前に設定し、後で戻す) */
function setupOrgChartPrint() {
  const chartEl = ocEl('oc-chart');
  window.addEventListener('beforeprint', () => {
    const avail = 1500; // A3横(420mm≒1587px)から余白を引いた幅
    chartEl.style.zoom = String(Math.min(1, avail / Math.max(1, chartEl.scrollWidth)));
  });
  window.addEventListener('afterprint', () => { chartEl.style.zoom = ''; });
  const btn = ocEl('oc-print');
  if (btn) btn.addEventListener('click', () => window.print());
}

async function initOrgChartPage() {
  try {
    await Auth.init();
  } catch (e) {
    console.error(e);
  }
  setupOrgChartPrint();
  if (Auth.mode !== 'entra') {
    ocEl('oc-chart').innerHTML = '<p style="margin:0;padding:24px 0;font-size:13px;color:#8a99a8">devモードでは組織図を確認できません(Entra IDでのサインインが必要です)</p>';
    return;
  }
  ocEl('oc-chart').innerHTML = '<p style="margin:0;padding:24px 0;font-size:13px;color:#8a99a8">読み込み中…</p>';
  try {
    const [org, manual] = await Promise.all([loadOrgData(), api('/api/orgchart-titles')]);
    renderOrgChart(buildOrgChart(org, manual));
    const failed = [...(org.failedLeft || []), ...(org.failedRight || [])];
    ocEl('oc-notice').textContent = failed.length ? `次のグループを取得できませんでした(該当する方が表示されていない可能性があります): ${failed.join('、')}` : '';
  } catch (e) {
    console.error(e);
    ocEl('oc-chart').innerHTML = `<p style="margin:0;padding:24px 0;font-size:13px;color:#c05a5a">組織図を読み込めませんでした: ${esc(e.message || String(e))}</p>`;
  }
}
