// 拠点・会議室のマスタと曜日パターンのダミー予約(ハンドオフ準拠)。
// rooms.html(会議室予約サンプル)と schedule.html(スケジュール画面)で共有する。
// 本番はGraph /places 等に置き換える想定(README「Microsoft 365 連携」参照)。
'use strict';

const SITES = [
  { id: 'hq', name: '平野展示場' },
  { id: 'osaka', name: '花博展示場' },
  { id: 'sendai', name: '中百舌鳥展示場' },
  { id: 'site', name: '福田展示場' }
];
const ROOMS = [
  { id: 'a', site: 'hq', name: '会議室A', meta: '3F ・ 12名 ・ TV会議', color: '#2e6fc0' },
  { id: 'b', site: 'hq', name: '会議室B', meta: '3F ・ 6名 ・ モニタ', color: '#2e7d52' },
  { id: 'hall', site: 'hq', name: '大会議室', meta: '1F ・ 40名 ・ 配信設備', color: '#7b5ea8' },
  { id: 'ex', site: 'hq', name: '応接室', meta: '2F ・ 4名', color: '#b8571f' },
  { id: 'os1', site: 'osaka', name: '会議室1', meta: '5F ・ 10名 ・ TV会議', color: '#2e6fc0' },
  { id: 'os2', site: 'osaka', name: '会議室2', meta: '5F ・ 6名', color: '#2e7d52' },
  { id: 'osex', site: 'osaka', name: '応接室', meta: '5F ・ 4名', color: '#b8571f' },
  { id: 'sd1', site: 'sendai', name: '打合せ室', meta: '2F ・ 8名 ・ モニタ', color: '#33718f' },
  { id: 'sd2', site: 'sendai', name: '小会議室', meta: '2F ・ 4名', color: '#7b5ea8' },
  { id: 'gen', site: 'site', name: '商談室', meta: '1F ・ 8名', color: '#33718f' },
  { id: 'gen2', site: 'site', name: 'セミナールーム', meta: '2F ・ 20名', color: '#2e7d52' }
];

// 曜日パターンの擬似予約(Exchange連携までの「他人の予約」ダミー)。part=自分が参加
const PATTERNS = {
  a: [
    { dow: 3, start: '14:00', end: '15:30', title: '協力会社 打合せ', owner: '田中 健太', part: true },
    { dow: 4, start: '09:00', end: '10:00', title: '工程確認', owner: '鈴木 花子' }
  ],
  b: [
    { dow: 2, start: '13:00', end: '14:00', title: '採用面接', owner: '中村 由美' }
  ],
  hall: [
    { dow: 5, start: '08:30', end: '09:30', title: '全体朝礼', owner: '鈴木 花子' },
    { dow: 2, start: '15:00', end: '17:00', title: '安全大会 準備', owner: '加藤 剛' }
  ],
  ex: [
    { dow: 1, start: '11:00', end: '12:00', title: '来客(○○商事様)', owner: '山本 大輔' },
    { dow: 4, start: '15:00', end: '16:00', title: '来客(△△工業様)', owner: '山本 大輔' }
  ],
  gen: [
    { dow: 1, start: '08:00', end: '08:30', title: '朝礼・KY活動', owner: '吉田 亮' },
    { dow: 3, start: '13:00', end: '14:00', title: '施工打合せ', owner: '吉田 亮' }
  ],
  gen2: [
    { dow: 2, start: '08:00', end: '09:00', title: '安全パトロール前ミーティング', owner: '加藤 剛' },
    { dow: 4, start: '16:00', end: '17:00', title: '協力会社 安全教育', owner: '田中 健太' }
  ],
  os1: [
    { dow: 1, start: '09:30', end: '11:00', title: '関西営業 週次会議', owner: '伊藤 隆' },
    { dow: 3, start: '14:00', end: '16:00', title: '見積レビュー', owner: '林 美穂' }
  ],
  os2: [
    { dow: 2, start: '10:00', end: '11:00', title: '協力会社 打合せ', owner: '高橋 直子' }
  ],
  osex: [
    { dow: 4, start: '11:00', end: '12:00', title: '来客(□□建材様)', owner: '伊藤 隆' }
  ],
  sd1: [
    { dow: 1, start: '13:00', end: '14:30', title: '東北エリア 工程会議', owner: '木村 修' },
    { dow: 4, start: '10:00', end: '11:00', title: '採用説明会 準備', owner: '中村 由美' }
  ],
  sd2: [
    { dow: 3, start: '15:00', end: '16:00', title: '個別面談', owner: '木村 修' }
  ]
};

function siteRooms(siteId) { return ROOMS.filter(r => r.site === siteId); }
function roomById(id) { return ROOMS.find(r => r.id === id); }

function isoDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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
