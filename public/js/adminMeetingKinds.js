// 管理画面「打ち合わせの区分」タブ(2026-10-30・ユーザー依頼)。予定の作成・変更画面の「区分」プルダウンの選択肢(初回など)を登録する。
// 保存先は meeting_kinds(一覧ごと置き換える)。選んだ区分は、予定を保存するとき Outlook(Exchange)の分類項目に、ここの名前のまま付く。
// admin.js の renderTable から renderMeetingKindsTab() が呼ばれる(ベスポーク管理タブ)。
'use strict';

async function renderMeetingKindsTab() {
  document.getElementById('table-head').innerHTML = `
    <span style="font-size:12px;color:#8a99a8;flex:1;min-width:0">予定の作成・変更画面の「区分」プルダウンの選択肢。選んだ区分は、Outlook の予定の分類項目に付きます。</span>`;
  const body = document.getElementById('table-body');
  body.innerHTML = '<div style="padding:32px 24px;text-align:center;font-size:13px;color:#8a99a8">読み込み中…</div>';
  let rows;
  try {
    rows = await api('/api/meeting-kinds');
  } catch (e) {
    body.innerHTML = `<div style="padding:24px;font-size:13px;color:#c05a5a">${esc(e.message || String(e))}</div>`;
    return;
  }
  if (state.tab !== 'meeting-kinds') return; // 取得中にタブが切り替わっていたら描き替えない

  const inputStyle = 'padding:6px 8px;font-size:12px';
  const rowHtml = r => `
    <div data-krow style="display:flex;align-items:center;gap:10px;padding:10px 24px;border-bottom:1px solid #f2f5f9;flex-wrap:wrap">
      <input class="in-input" data-k="label" maxlength="30" value="${esc(r.label)}" placeholder="区分の名前(例: 初回)" style="${inputStyle};width:260px">
      <input class="in-input" data-k="sort" type="number" min="0" max="9999" value="${esc(r.sort)}" style="${inputStyle};width:70px" title="表示順(小さい順)">
      <button type="button" data-k-del class="hv-btn-danger" style="border:1px solid #e4eaf1;background:#ffffff;border-radius:7px;padding:3px 12px;cursor:pointer;color:#a8b5c2;font-size:12px;font-family:inherit">削除</button>
    </div>`;
  body.innerHTML = `
    <div style="padding:16px 24px;border-bottom:1px solid #e8edf3;background:#f7fafd;display:flex;flex-direction:column;gap:8px">
      <span style="font-size:13px;font-weight:700;color:#1c2b3a">打ち合わせの区分</span>
      <span style="font-size:11px;color:#8a99a8">区分の名前は、そのまま Outlook の分類項目の名前になります(30文字まで・重複不可・「;」は使えません)。表示順は小さい順です。名前を変えたり消したりしても、保存済みの予定の分類項目は、そのまま残ります。</span>
      <div style="display:flex;gap:10px;align-items:center">
        <button id="k-add" type="button" class="hv-btn-primary" style="border:none;background:#1e5fa8;color:#ffffff;font-weight:700;border-radius:8px;padding:7px 16px;font-size:12px;font-family:inherit;cursor:pointer">行を追加</button>
        <button id="k-save" type="button" class="hv-btn-primary" style="border:none;background:#1e5fa8;color:#ffffff;font-weight:700;border-radius:8px;padding:7px 16px;font-size:12px;font-family:inherit;cursor:pointer">保存</button>
        <span id="k-result" style="font-size:12px"></span>
      </div>
    </div>
    <div id="k-rows">${rows.map(rowHtml).join('') || '<div id="k-empty" style="padding:24px;font-size:13px;color:#8a99a8">区分がありません(予定の画面にプルダウンは出ません)。「行を追加」で入力してください。</div>'}</div>`;

  const wrap = document.getElementById('k-rows');
  const bind = row => row.querySelector('[data-k-del]').addEventListener('click', () => { row.remove(); });
  wrap.querySelectorAll('[data-krow]').forEach(bind);
  document.getElementById('k-add').addEventListener('click', () => {
    const empty = document.getElementById('k-empty');
    if (empty) empty.remove();
    wrap.insertAdjacentHTML('beforeend', rowHtml({ label: '', sort: wrap.querySelectorAll('[data-krow]').length + 1 }));
    bind(wrap.lastElementChild);
  });
  document.getElementById('k-save').addEventListener('click', async () => {
    const resultEl = document.getElementById('k-result');
    const items = [...wrap.querySelectorAll('[data-krow]')].map(row => {
      const v = k => row.querySelector(`[data-k=${k}]`).value.trim();
      return { label: v('label'), sort: Number(v('sort')) || 0 };
    });
    resultEl.textContent = '保存中…'; resultEl.style.color = '#8a99a8';
    try {
      await api('/api/admin/meeting-kinds', { method: 'PUT', body: { items } });
      resultEl.textContent = '✓ 保存しました'; resultEl.style.color = '#2e7d52';
    } catch (e) {
      resultEl.textContent = `✗ ${e.message}`; resultEl.style.color = '#c05a5a';
    }
  });
}
