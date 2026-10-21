// 管理画面「組織図の役職」タブ(2026-10-20)。MS365に無い課長以下の役職と、兼任(MS365のグループに入っていない部門への追加)を手入力する。
// 表示の元になる人・部門は、組織図のページと同じ(orgData.js の loadOrgData + orgChart.js の buildOrgChart)。保存先は orgchart_titles。
// admin.js の renderTable から renderOrgChartTitlesTab() が呼ばれる(ベスポーク管理タブ)。
'use strict';

let orgTitlesCache = null; // { org, manual:[{email,dept,title,sort}] }

async function loadOrgTitlesData(force) {
  if (orgTitlesCache && !force) return orgTitlesCache;
  const [org, manual] = await Promise.all([loadOrgData(), api('/api/orgchart-titles')]);
  const partial = [...(org.failedLeft || []), ...(org.failedRight || [])].length > 0;
  const data = { org, manual, partial };
  if (!partial) orgTitlesCache = data; // グループの取得が一部失敗したときはキャッシュしない(次に開いたとき取り直す)
  return data;
}

function orgManualFind(manual, key, dept) {
  return manual.find(r => r.email === key && r.dept === dept) || null;
}

async function saveOrgTitle(email, dept, title, sort) {
  await api('/api/admin/orgchart-titles', { method: 'PUT', body: { email, dept, title, sort } });
  // サーバーが正規化した値(メールの小文字化・役職の整形・表示順の範囲)を反映するため、手入力の一覧を取り直す
  const manual = await api('/api/orgchart-titles');
  if (orgTitlesCache) orgTitlesCache.manual = manual;
  return manual;
}

async function renderOrgChartTitlesTab() {
  document.getElementById('table-head').innerHTML = `
    <span style="font-size:12px;color:#8a99a8;width:150px;flex-shrink:0">部門</span>
    <span style="font-size:12px;color:#8a99a8;flex:1;min-width:0">氏名</span>
    <span style="font-size:12px;color:#8a99a8;width:200px;flex-shrink:0">役職(手入力。課長・係長・主任など)</span>
    <span style="font-size:12px;color:#8a99a8;width:70px;flex-shrink:0">表示順</span>`;
  const body = document.getElementById('table-body');
  body.innerHTML = '<div style="padding:32px 24px;text-align:center;font-size:13px;color:#8a99a8">読み込み中…</div>';
  let data;
  try {
    data = await loadOrgTitlesData(false);
  } catch (e) {
    body.innerHTML = `<div style="padding:24px;font-size:13px;color:#c05a5a">${esc(e.message || String(e))}</div>`;
    return;
  }
  if (state.tab !== 'orgchart-titles') return; // 取得中にタブが切り替わっていたら描き替えない

  const { org, partial } = data;
  let manual = data.manual;
  const people = orgChartPeopleForAdmin(org, manual);
  const known = new Set(Object.keys(org.names || {}));
  [...(org.left || []), ...(org.right || [])].forEach(g => g.members.forEach(m => known.add(orgKeyOf(m))));

  const inputStyle = 'padding:6px 8px;font-size:12px';
  const rowHtml = p => {
    const def = orgManualFind(manual, p.key, '');
    const own = orgManualFind(manual, p.key, p.dept);
    const cur = own || def;
    const ms365 = (!cur || !cur.title) && p.title ? p.title : ''; // MS365にある役職(手入力の役職が無いとき、参考に表示)
    return `
    <div data-row="${esc(p.key)}" data-dept="${esc(own ? p.dept : '')}" style="display:flex;align-items:center;gap:24px;padding:10px 24px;border-bottom:1px solid #f2f5f9">
      <span style="font-size:12px;width:150px;flex-shrink:0;color:#6b7d8f">${esc(p.dept)}${p.section ? ` / ${esc(p.section)}` : ''}</span>
      <span style="font-size:13px;flex:1;min-width:0;color:#1c2b3a">${esc(p.name)}${p.added ? ' <span style="font-size:11px;color:#8a99a8">(兼任・追加)</span>' : ''}${ms365 ? ` <span style="font-size:11px;color:#8a99a8">MS365の役職: ${esc(ms365)}</span>` : ''}</span>
      <span style="width:200px;flex-shrink:0;display:flex;align-items:center;gap:6px">
        <input class="in-input" data-title maxlength="30" value="${esc(cur ? cur.title : '')}" placeholder="例: 課長" style="${inputStyle};width:130px">
        <span data-result style="font-size:12px;white-space:nowrap"></span>
      </span>
      <input class="in-input" data-sort type="number" min="0" max="9999" value="${esc(cur ? cur.sort : 0)}" style="${inputStyle};width:70px;flex-shrink:0">
    </div>`;
  };

  // 兼任・追加の入力欄(MS365のグループに入っていない部門に、別の部門の人を載せる)と、名簿にいない行の一覧
  const peopleOptions = Object.entries(org.names || {}).sort((a, b) => a[1].localeCompare(b[1], 'ja'))
    .map(([email, name]) => `<option value="${esc(email)}">${esc(name)}(${esc(email)})</option>`).join('');
  // 載せる先は、MS365のグループ(社員名簿・組織図と同じ区分)から選ぶ。選んだグループが組織図のどの部門・区分に当たるかは、枠組み(ORG_CHART_FRAME)から決める(保存は「部門名/区分名」)
  const groupChoices = orgChartGroupChoices();
  const deptOptions = groupChoices.map(c => `<option value="${esc(c.dept)}">${esc(c.dept === c.label ? c.label : `${c.label} → ${c.dept}`)}</option>`).join('');
  const extraRows = manual.filter(r => r.dept !== '');
  const orphans = partial ? [] : manual.filter(r => !known.has(r.email)); // グループの取得に失敗したときは、名簿にいないかの判定をしない(有効な行を消してしまわないため)
  const extraHtml = `
    <div style="padding:16px 24px;border-bottom:1px solid #e8edf3;background:#f7fafd;display:flex;flex-direction:column;gap:10px">
      <span style="font-size:13px;font-weight:700;color:#1c2b3a">兼任・追加(MS365のグループに入っていない部門に、人を追加で載せる)</span>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <select class="in-input" id="oc-add-person" style="${inputStyle};max-width:260px">${peopleOptions}</select>
        <select class="in-input" id="oc-add-dept" style="${inputStyle};max-width:260px" title="MS365のグループ(社員名簿と同じ区分)から選びます">${deptOptions}</select>
        <input class="in-input" id="oc-add-title" maxlength="30" placeholder="役職(例: 次長(兼任))" style="${inputStyle};width:160px">
        <button id="oc-add-btn" type="button" class="hv-btn-primary" style="border:none;background:#1e5fa8;color:#ffffff;font-weight:700;border-radius:8px;padding:7px 16px;font-size:12px;font-family:inherit;cursor:pointer">追加</button>
        <span id="oc-add-result" style="font-size:12px"></span>
      </div>
      <span style="font-size:11px;color:#8a99a8">階層(①〜④)は、MS365の「従業員の種類」の数字で決まります(通常のメンバー)。ここで追加する兼任の人は、載せる先は、MS365のグループ(社員名簿と同じ区分)から選びます。役職が「次長」なら④、「部長・取締役部長・室長・マネージャー」なら③の枠に載ります(「次長(兼任)」のように括弧の注記つきも同じ)。それ以外は⑤のメンバーに載ります(ゆめすみかの列は、③=常務取締役・④=マネージャーの人だけなので、追加した人は⑤に載ります)。</span>
      ${extraRows.length ? `<div style="display:flex;flex-direction:column;gap:4px">${extraRows.map(r => `
        <div style="display:flex;gap:12px;align-items:center;font-size:12px"><span style="width:150px">${esc(r.dept)}</span><span style="flex:1">${esc((org.names || {})[r.email] || r.email)} — ${esc(r.title)}</span>
        <button type="button" data-del-extra data-del-email="${esc(r.email)}" data-del-dept="${esc(r.dept)}" class="hv-btn-danger" style="border:1px solid #e4eaf1;background:#ffffff;border-radius:7px;padding:3px 12px;cursor:pointer;color:#a8b5c2;font-size:12px;font-family:inherit">削除</button></div>`).join('')}</div>` : ''}
      ${partial ? '<div style="font-size:12px;color:#c05a5a">一部のグループを取得できなかったため、「名簿に見つからない行」の確認は行っていません。時間をおいて開き直してください。</div>' : ''}
      ${orphans.length ? `<div style="font-size:12px;color:#c05a5a">名簿に見つからない行があります(退職・名前の変更など): ${orphans.map(r => `${esc(r.email)}(${esc(r.dept || '既定')}・${esc(r.title)}) <button type="button" data-del-extra data-del-email="${esc(r.email)}" data-del-dept="${esc(r.dept)}" style="border:1px solid #e4eaf1;background:#ffffff;border-radius:7px;padding:2px 10px;cursor:pointer;font-size:11px;font-family:inherit">削除</button>`).join(' ・ ')}</div>` : ''}
    </div>`;

  body.innerHTML = extraHtml + (people.length ? people.map(rowHtml).join('') : '<div style="padding:24px;font-size:13px;color:#8a99a8">表示できる人がいません</div>');

  body.querySelectorAll('[data-row]').forEach(row => {
    const key = row.dataset.row;
    const dept = row.dataset.dept; // '' = 部門を問わない既定の役職として保存
    const titleEl = row.querySelector('[data-title]');
    const sortEl = row.querySelector('[data-sort]');
    const resultEl = row.querySelector('[data-result]');
    const save = async () => {
      resultEl.textContent = '保存中…'; resultEl.style.color = '#8a99a8';
      try {
        await saveOrgTitle(key, dept, titleEl.value.trim(), Number(sortEl.value) || 0);
        resultEl.textContent = '✓'; resultEl.style.color = '#2e7d52';
      } catch (e) {
        resultEl.textContent = `✗ ${e.message}`; resultEl.style.color = '#c05a5a';
      }
    };
    titleEl.addEventListener('change', save);
    sortEl.addEventListener('change', save);
  });
  body.querySelectorAll('[data-del-extra]').forEach(b => b.addEventListener('click', async () => {
    const email = b.dataset.delEmail, dept = b.dataset.delDept; // 「|」で連結せず、別の属性で持つ(キーに「|」が含まれても壊れない)
    if (!confirm('この行を削除しますか?')) return;
    try { await saveOrgTitle(email, dept, '', 0); renderOrgChartTitlesTab(); } catch (e) { alert(e.message); }
  }));
  const addBtn = document.getElementById('oc-add-btn');
  if (addBtn) addBtn.addEventListener('click', async () => {
    const resultEl = document.getElementById('oc-add-result');
    const email = document.getElementById('oc-add-person').value;
    const dept = document.getElementById('oc-add-dept').value; // 選んだMS365グループに当たる「部門名/区分名」
    const title = document.getElementById('oc-add-title').value.trim();
    if (!email || !title) { resultEl.textContent = '人と役職を入力してください'; resultEl.style.color = '#c05a5a'; return; }
    try {
      await saveOrgTitle(email, dept, title, 0);
      renderOrgChartTitlesTab();
    } catch (e) { resultEl.textContent = `✗ ${e.message}`; resultEl.style.color = '#c05a5a'; }
  });
}
