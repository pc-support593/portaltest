// 拠点・会議室マスタ(実際のExchange会議室リソース。5拠点33室)。
// rooms.html(デザインサンプル)と schedule.html(実データ連携)で共有する。
// schedule.js は email を Graph 呼び出し(getSchedule・resource出席者)に使う。
// マスタが増減したら Exchange 管理者に確認し、ここ1箇所を直す
// (最新一覧は Get-Mailbox -RecipientTypeDetails RoomMailbox で取得できる)。
//
// PATTERNS は rooms.html(デザインサンプル)専用の曜日パターンのダミー予約。
// ユーザーの指示によりサンプルデータは削除せず維持する(→ CLAUDE.md 実装ルール6)。
'use strict';

// 会議室の識別色(最大9室/拠点)。互いに判別しやすい別系統の色相で構成し、
// 白文字が乗る前提の彩度・明度に調整(青/赤/緑/橙/紫/ティール/ローズ/金茶/焦茶)
const ROOM_COLOR_PALETTE = ['#2e6fc0', '#c0392b', '#2e7d52', '#b8571f', '#7b5ea8', '#00838f', '#ad3f74', '#8a6d1f', '#5d4037'];

const SITES = [
  { id: 'hirano', name: '平野展示場' },
  { id: 'hanahaku', name: '花博展示場' },
  { id: 'nishinomiya', name: '西宮展示場' },
  { id: 'nakamozu', name: '中百舌鳥展示場' },
  { id: 'fukuda', name: '福田展示場' }
];

const ROOM_NAMES_BY_SITE = {
  hirano: [
    ['事務所棟3F Aテーブル(EV前)', 'Hirano_room1@yumesumika.com'],
    ['事務所棟3F Bテーブル(真ん中)', 'Hirano_room2@yumesumika.com'],
    ['事務所棟3F Cテーブル(ショールーム横)', 'Hirano_room3@yumesumika.com'],
    ['事務所棟1F MTR', 'Hirano_room4@yumesumika.com'],
    ['モデル(2F商談室)', 'Hirano_room5@yumesumika.com'],
    ['モデル(ダイニング)', 'Hirano_room6@yumesumika.com'],
    ['宿泊モデル(ダイニング)', 'Hirano_room7@yumesumika.com'],
    ['体感ルーム', 'Hirano_room8@yumesumika.com'],
    ['宿泊体験', 'Hirano_room9@yumesumika.com']
  ],
  hanahaku: [
    ['1F 6人テーブル(階段横)', 'Hanahaku_room1@yumesumika.com'],
    ['1F 4人テーブル(キッズ前)', 'Hanahaku_room2@yumesumika.com'],
    ['1F ダイニングテーブル(玄関前)', 'Hanahaku_room3@yumesumika.com'],
    ['2F 事務所隣り(MGルーム)', 'Hanahaku_room4@yumesumika.com'],
    ['モデル(2Fダイニング)', 'Hanahaku_room5@yumesumika.com'],
    ['モデル(3F展示場横)', 'Hanahaku_room6@yumesumika.com'],
    ['臨時 2階 リビングソファー', 'Hanahaku_room7@yumesumika.com']
  ],
  nishinomiya: [
    ['1F 個室①(6名テーブル)', 'Nishinomiya_room1@yumesumika.com'],
    ['1F 個室②(4名テーブル)', 'Nishinomiya_room2@yumesumika.com'],
    ['1F 個室②横', 'Nishinomiya_room3@yumesumika.com'],
    ['1F 事務所横', 'Nishinomiya_room4@yumesumika.com'],
    ['2F 階段側', 'Nishinomiya_room5@yumesumika.com'],
    ['2F 真ん中', 'Nishinomiya_room6@yumesumika.com'],
    ['2F 奥', 'Nishinomiya_room7@yumesumika.com'],
    ['2.5F ダイニングテーブル(LIXIL)', 'Nishinomiya_room8@yumesumika.com'],
    ['宿泊体験', 'Nishinomiya_room9@yumesumika.com']
  ],
  nakamozu: [
    ['2F キッズコーナー', 'Nakamozu_room1@yumesumika.com'],
    ['2F 奥の奥', 'Nakamozu_room2@yumesumika.com'],
    ['2F 奥の手前', 'Nakamozu_room3@yumesumika.com'],
    ['1F ダイニングテーブル', 'Nakamozu_room4@yumesumika.com'],
    ['1F リビングソファー', 'Nakamozu_room5@yumesumika.com'],
    ['1F 和室', 'Nakamozu_room6@yumesumika.com']
  ],
  fukuda: [
    ['1階', 'Fukuda_room1@yumesumika.com'],
    ['2階', 'Fukuda_room2@yumesumika.com']
  ]
};

const ROOMS = SITES.flatMap(s => ROOM_NAMES_BY_SITE[s.id].map(([name, email], i) => ({
  id: `${s.id}${i + 1}`, site: s.id, name, email, meta: '', color: ROOM_COLOR_PALETTE[i % ROOM_COLOR_PALETTE.length]
})));

function siteRooms(siteId) { return ROOMS.filter(r => r.site === siteId); }
function roomById(id) { return ROOMS.find(r => r.id === id); }

function isoDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 曜日パターンの擬似予約(rooms.html のデザインサンプル専用。part=自分が参加)。
// 旧ダミー会議室のサンプル予約を、実在の会議室名に対応付けて維持している(内容は変更していない)
const PATTERNS = {
  hirano1: [
    { dow: 3, start: '14:00', end: '15:30', title: '協力会社 打合せ', owner: '田中 健太', part: true },
    { dow: 4, start: '09:00', end: '10:00', title: '工程確認', owner: '鈴木 花子' }
  ],
  hirano2: [
    { dow: 2, start: '13:00', end: '14:00', title: '採用面接', owner: '中村 由美' }
  ],
  hirano4: [
    { dow: 5, start: '08:30', end: '09:30', title: '全体朝礼', owner: '鈴木 花子' },
    { dow: 2, start: '15:00', end: '17:00', title: '安全大会 準備', owner: '加藤 剛' }
  ],
  hirano5: [
    { dow: 1, start: '11:00', end: '12:00', title: '来客(○○商事様)', owner: '山本 大輔' },
    { dow: 4, start: '15:00', end: '16:00', title: '来客(△△工業様)', owner: '山本 大輔' }
  ],
  hanahaku1: [
    { dow: 1, start: '09:30', end: '11:00', title: '関西営業 週次会議', owner: '伊藤 隆' },
    { dow: 3, start: '14:00', end: '16:00', title: '見積レビュー', owner: '林 美穂' }
  ],
  hanahaku2: [
    { dow: 2, start: '10:00', end: '11:00', title: '協力会社 打合せ', owner: '高橋 直子' }
  ],
  hanahaku4: [
    { dow: 4, start: '11:00', end: '12:00', title: '来客(□□建材様)', owner: '伊藤 隆' }
  ],
  nakamozu4: [
    { dow: 1, start: '13:00', end: '14:30', title: '東北エリア 工程会議', owner: '木村 修' },
    { dow: 4, start: '10:00', end: '11:00', title: '採用説明会 準備', owner: '中村 由美' }
  ],
  nakamozu2: [
    { dow: 3, start: '15:00', end: '16:00', title: '個別面談', owner: '木村 修' }
  ],
  fukuda1: [
    { dow: 1, start: '08:00', end: '08:30', title: '朝礼・KY活動', owner: '吉田 亮' },
    { dow: 3, start: '13:00', end: '14:00', title: '施工打合せ', owner: '吉田 亮' }
  ],
  fukuda2: [
    { dow: 2, start: '08:00', end: '09:00', title: '安全パトロール前ミーティング', owner: '加藤 剛' },
    { dow: 4, start: '16:00', end: '17:00', title: '協力会社 安全教育', owner: '田中 健太' }
  ]
};

/** 指定会議室・日付の予約一覧(曜日パターン + 渡された実予約、開始時刻順)。純粋関数。 */
function bookingsFor(roomId, date, extraBookings) {
  const dow = date.getDay();
  const base = (dow === 0 || dow === 6) ? [] :
    (PATTERNS[roomId] || []).filter(p => p.dow === dow).map(p => ({ ...p }));
  const key = isoDate(date);
  const own = (extraBookings || [])
    .filter(b => b.room === roomId && b.date === key)
    .map(b => ({ ...b, user: true }));
  return base.concat(own).sort((x, y) => x.start.localeCompare(y.start));
}
