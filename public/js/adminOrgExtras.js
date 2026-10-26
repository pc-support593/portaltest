// 管理画面「組織図の補足」タブ(2026-10-27・ユーザー依頼)。組織図の部門の枠の一番下に出す、次の2種類の行を入力する。
//   ・人数だけの行: 「フィリピン 3名」のような行(行の名前と人数)。部門の人数に、その人数を足す
//   ・手動の人: 「リーダー 岸上大介」のような行(役職と氏名)。MS365に無い人を載せる。部門の人数に1を足す
// 保存先は orgchart_extras(一覧ごと置き換える)。表示は組織図のページだけ(社員名簿・出勤状況には出ない)。
// admin.js の renderTable から renderOrgExtrasTab() が呼ばれる(ベスポーク管理タブ)。
'use strict';

function orgExtrasDeptNames() {
  return [...ORG_CHART_FRAME.columns, ...(ORG_CHART_FRAME.sideDepts || [])].map(c => c.name);
}

async function renderOrgExtrasTab() {
  document.getElementById('table-head').innerHTML = `
    <span style="font-size:12px;color:#8a99a8;flex:1;min-width:0">組織図の部門の枠の一番下に出す行(人数だけの行・手動の人)。部門の人数に足されます。</span>`;
  const body = document.getElementById('table-body');
  body.innerHTML = '<div style="padding:32px 24px;text-align:center;font-size:13px;color:#8a99a8">読み込み中…</div>';
  let rows;
  try {
    rows = await api('/api/orgchart-extras');
  } catch (e) {
    body.innerHTML = `<div style="padding:24px;font-size:13px;color:#c05a5a">${esc(e.message || String(e))}</div>`;
    return;
  }
  if (state.tab !== 'orgchart-extras') return; // 取得中にタブが切り替わっていたら描き替えない

  const depts = orgExtrasDeptNames();
  const inputStyle = 'padding:6px 8px;font-size:12px';
  const rowHtml = r => `
    <div data-xrow style="display:flex;align-items:center;gap:10px;padding:10px 24px;border-bottom:1px solid #f2f5f9;flex-wrap:wrap">
      <select class="in-input" data-x="dept" style="${inputStyle};width:230px">${(depts.includes(r.dept) ? depts : [...depts, r.dept]).map(d => `<option value="${esc(d)}"${d === r.dept ? ' selected' : ''}>${esc(d)}${depts.includes(d) ? '' : '(組織図の枠にない部門)'}</option>`).join('')}</select>
      <select class="in-input" data-x="kind" style="${inputStyle};width:130px">
        <option value="count"${r.kind === 'count' ? ' selected' : ''}>人数だけの行</option>
        <option value="person"${r.kind === 'person' ? ' selected' : ''}>手動の人</option>
      </select>
      <input class="in-input" data-x="title" maxlength="30" value="${esc(r.title)}" placeholder="行の名前 / 役職(例: フィリピン / リーダー)" style="${inputStyle};width:230px">
      <input class="in-input" data-x="name" maxlength="30" value="${esc(r.name)}" placeholder="氏名(手動の人のみ)" style="${inputStyle};width:150px">
      <input class="in-input" data-x="count" type="number" min="0" max="9999" value="${esc(r.count)}" placeholder="人数" style="${inputStyle};width:80px" title="人数だけの行の人数">
      <input class="in-input" data-x="sort" type="number" min="0" max="9999" value="${esc(r.sort)}" style="${inputStyle};width:70px" title="表示順(小さい順。枠の一番下で、この順に並びます)">
      <button type="button" data-x-del class="hv-btn-danger" style="border:1px solid #e4eaf1;background:#ffffff;border-radius:7px;padding:3px 12px;cursor:pointer;color:#a8b5c2;font-size:12px;font-family:inherit">削除</button>
    </div>`;
  body.innerHTML = `
    <div style="padding:16px 24px;border-bottom:1px solid #e8edf3;background:#f7fafd;display:flex;flex-direction:column;gap:8px">
      <span style="font-size:13px;font-weight:700;color:#1c2b3a">組織図の補足</span>
      <span style="font-size:11px;color:#8a99a8">「人数だけの行」は「行の名前 ○名」の形で、部門の枠の一番下に出ます(例: フィリピン 3名)。「手動の人」は、役職と氏名の行で、MS365に無い人を載せます。どちらも、部門の人数(見出しの数字)に足されます。表示順は小さい順です。</span>
      <div style="display:flex;gap:10px;align-items:center">
        <button id="x-add" type="button" class="hv-btn-primary" style="border:none;background:#1e5fa8;color:#ffffff;font-weight:700;border-radius:8px;padding:7px 16px;font-size:12px;font-family:inherit;cursor:pointer">行を追加</button>
        <button id="x-save" type="button" class="hv-btn-primary" style="border:none;background:#1e5fa8;color:#ffffff;font-weight:700;border-radius:8px;padding:7px 16px;font-size:12px;font-family:inherit;cursor:pointer">保存</button>
        <span id="x-result" style="font-size:12px"></span>
      </div>
    </div>
    <div id="x-rows">${rows.map(rowHtml).join('') || '<div id="x-empty" style="padding:24px;font-size:13px;color:#8a99a8">行がありません。「行を追加」で入力してください。</div>'}</div>`;

  const wrap = document.getElementById('x-rows');
  const syncRow = row => { // 種類に合わせて、使わない欄を無効にする
    const kind = row.querySelector('[data-x=kind]').value;
    row.querySelector('[data-x=name]').disabled = kind !== 'person';
    row.querySelector('[data-x=count]').disabled = kind !== 'count';
  };
  const bind = row => {
    syncRow(row);
    row.querySelector('[data-x=kind]').addEventListener('change', () => syncRow(row));
    row.querySelector('[data-x-del]').addEventListener('click', () => { row.remove(); });
  };
  wrap.querySelectorAll('[data-xrow]').forEach(bind);
  document.getElementById('x-add').addEventListener('click', () => {
    const empty = document.getElementById('x-empty');
    if (empty) empty.remove();
    wrap.insertAdjacentHTML('beforeend', rowHtml({ dept: depts[0], kind: 'count', title: '', name: '', count: 0, sort: 0 }));
    bind(wrap.lastElementChild);
  });
  document.getElementById('x-save').addEventListener('click', async () => {
    const resultEl = document.getElementById('x-result');
    const items = [...wrap.querySelectorAll('[data-xrow]')].map(row => {
      const v = k => row.querySelector(`[data-x=${k}]`).value.trim();
      return { dept: v('dept'), kind: v('kind'), title: v('title'), name: v('name'), count: Number(v('count')) || 0, sort: Number(v('sort')) || 0 };
    });
    resultEl.textContent = '保存中…'; resultEl.style.color = '#8a99a8';
    try {
      await api('/api/admin/orgchart-extras', { method: 'PUT', body: { items } });
      resultEl.textContent = '✓ 保存しました'; resultEl.style.color = '#2e7d52';
    } catch (e) {
      resultEl.textContent = `✗ ${e.message}`; resultEl.style.color = '#c05a5a';
    }
  });
}
