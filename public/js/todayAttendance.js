// 本日の出勤者ページ(2026-10-02追加。ユーザー指示)。
// ポータルトップの「〜班出勤日」バッジから ?team=A&group=sunday_off のように遷移してくる。
// A/B/C班ローテーションの仕組みについては organization.js の社員名簿ページ・
// yumesumikaSchedule.js のゆめすみかスタッフ予定ページと同じ Graph 連携パターンを使う。
'use strict';

const params = new URLSearchParams(location.search);
const TEAM = params.get('team') || '';
const GROUP = params.get('group') || '';
const GROUP_LABEL = GROUP === 'wednesday_off' ? '水曜定休' : GROUP === 'sunday_off' ? '日曜定休' : '';

/** roomsData.jsはこのページでは読み込まないため同じ4行を複製(workCalendar.jsと同方針) */
function isoDate(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Graphのエラーレスポンスから可能な限り具体的なメッセージを取り出す */
async function graphErrorMessage(res) {
  try {
    const data = await res.json();
    if (data && data.error) return `HTTP ${res.status}: ${data.error.code || ''} ${data.error.message || ''}`.trim();
  } catch { /* 本文がJSONでない場合はステータスのみ */ }
  return `HTTP ${res.status}`;
}

/** 指定したメールアドレスのユーザー情報(表示名・電話番号)を個別に取得する
    (yumesumikaSchedule.js の fetchStaticMembers と同じ方式。既存のUser.Read.Allで足りる)。
    1人ずつtry/catchし、取得に失敗した人はメールアドレスをそのまま表示名にする */
async function fetchMemberDetails(emails) {
  const token = await Auth.getGraphToken(['User.Read.All']);
  const results = await Promise.all(emails.map(async email => {
    try {
      const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}?$select=id,displayName,mail,businessPhones,mobilePhone`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error(await graphErrorMessage(res));
      const u = await res.json();
      return {
        name: u.displayName || email,
        email: u.mail || email,
        // common.jsのphoneListOf()と同じ方式(携帯電話+事業所の電話をすべて表示)
        phone: phoneListOf(u).join(' / ')
      };
    } catch (e) {
      console.error(`「${email}」のユーザー情報取得に失敗しました`, e);
      return { name: email, email, phone: '' };
    }
  }));
  const collator = (a, b) => (a.name || '').localeCompare(b.name || '', 'ja');
  return results.sort(collator);
}

/** organization.js の renderColumn と同じ見た目(丸アバター+氏名+メール+電話)の一覧行 */
function memberRowHtml(m) {
  return `
  <div style="display:flex;align-items:center;gap:14px;padding:11px 20px;border-bottom:1px solid #f2f5f9">
    <div style="width:32px;height:32px;border-radius:50%;background:#4a7fc0;color:#ffffff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0">${esc(m.name.charAt(0))}</div>
    <span style="font-size:13px;font-weight:700;color:#1c2b3a;min-width:110px">${esc(m.name)}</span>
    <span style="font-size:12px;color:#6b7d8f;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.email)}</span>
    <span style="font-size:12px;color:#6b7d8f;white-space:nowrap">${esc(m.phone || '未登録')}</span>
  </div>`;
}

async function render() {
  const el = document.getElementById('attendance-list');
  document.getElementById('attendance-title').textContent = TEAM ? `本日の出勤者(${esc(TEAM)}班${GROUP_LABEL ? ' ・ ' + esc(GROUP_LABEL) : ''})` : '本日の出勤者';

  if (!TEAM || !GROUP) {
    el.innerHTML = '<p style="margin:0;padding:24px 20px;font-size:13px;color:#8a99a8">表示するグループ・班が指定されていません。ポータルトップの「〜班出勤日」から開いてください。</p>';
    return;
  }
  if (Auth.mode !== 'entra') {
    el.innerHTML = '<p style="margin:0;padding:24px 20px;font-size:13px;color:#8a99a8">devモードでは出勤者情報を確認できません(Entra IDでのサインインが必要です)</p>';
    return;
  }
  el.innerHTML = '<p style="margin:0;padding:24px 20px;font-size:13px;color:#8a99a8">読み込み中…</p>';
  try {
    const todayIso = isoDate(new Date());
    const rows = await api(`/api/shift-teams?group=${encodeURIComponent(GROUP)}&team=${encodeURIComponent(TEAM)}&date=${todayIso}`);
    if (!rows.length) {
      el.innerHTML = '<p style="margin:0;padding:24px 20px;font-size:13px;color:#8a99a8">該当するメンバーが見つかりませんでした</p>';
      return;
    }
    const members = await fetchMemberDetails(rows.map(r => r.email));
    el.innerHTML = `
      <div style="padding:13px 20px;border-bottom:1px solid #e8edf3">
        <span style="font-size:11px;color:#8a99a8">${members.length}名</span>
      </div>
      ${members.map(memberRowHtml).join('')}`;
  } catch (e) {
    console.error(e);
    el.innerHTML = `<p style="margin:0;padding:24px 20px;font-size:13px;color:#c05a5a">${esc(e.message || String(e))}</p>`;
  }
}

(async function init() {
  try {
    await Auth.init();
    await render();
  } catch (e) {
    console.error(e);
    document.getElementById('attendance-list').innerHTML =
      `<p style="margin:0;padding:24px 20px;font-size:13px;color:#c05a5a">読み込みに失敗しました: ${esc(e.message || e)}</p>`;
  }
})();
