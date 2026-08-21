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

// 2026-07-01〜2026-08-23 の rooms.html 用フローズンサンプル(ユーザー指示・2026-08-21)。
// 1日1〜5件・会議室は重複しないよう固定シードで一度だけ生成した結果をそのまま保存(再生成しない)。
// この期間は操作(予約作成・変更・取消)を行わない運用のため、bookingsFor はこのデータのみを返す
// (user フラグを付けないので rooms.js の編集可否判定 !!b.user により自動的に操作不可になる)
const SAMPLE_HISTORY_START = '2026-07-01';
const SAMPLE_HISTORY_END = '2026-08-23';
const SAMPLE_HISTORY = {
  '2026-07-01': [{ room: 'nakamozu3', start: '09:00', end: '10:30', title: '商談', owner: '伊藤 隆' }, { room: 'hanahaku2', start: '09:30', end: '10:00', title: '打合せ', owner: '林 美穂' }, { room: 'hanahaku7', start: '10:30', end: '11:00', title: '見積レビュー', owner: '木村 修' }, { room: 'nakamozu4', start: '19:00', end: '20:30', title: '引き渡し前確認', owner: '松本 恵' }],
  '2026-07-02': [{ room: 'nishinomiya2', start: '09:30', end: '10:30', title: '引き渡し前確認', owner: '木村 修' }, { room: 'fukuda1', start: '12:00', end: '13:30', title: '個別面談', owner: '加藤 剛' }, { room: 'hanahaku1', start: '16:00', end: '16:30', title: '契約打合せ', owner: '鈴木 花子' }],
  '2026-07-03': [{ room: 'hirano7', start: '09:00', end: '10:30', title: '資料作成', owner: '鈴木 花子' }, { room: 'nishinomiya5', start: '15:30', end: '16:30', title: '週次会議', owner: '林 美穂' }, { room: 'nishinomiya1', start: '17:00', end: '18:30', title: '採用面接', owner: '吉田 亮' }],
  '2026-07-04': [{ room: 'hirano4', start: '09:00', end: '10:00', title: '来客対応', owner: '松本 恵' }, { room: 'nishinomiya8', start: '18:30', end: '19:30', title: '現地調査 打合せ', owner: '田中 健太' }, { room: 'nakamozu4', start: '20:00', end: '21:00', title: '商談', owner: '山本 大輔' }],
  '2026-07-05': [{ room: 'hanahaku4', start: '10:30', end: '11:30', title: 'OB訪問対応', owner: '高橋 直子' }, { room: 'nishinomiya4', start: '10:30', end: '11:00', title: '施工打合せ', owner: '小林 勇人' }, { room: 'fukuda2', start: '16:00', end: '16:30', title: 'クレーム対応会議', owner: '鈴木 花子' }],
  '2026-07-06': [{ room: 'hirano6', start: '09:30', end: '10:00', title: '打合せ', owner: '鈴木 花子' }, { room: 'hirano2', start: '10:30', end: '12:00', title: '採用面接', owner: '中村 由美' }, { room: 'nakamozu5', start: '12:30', end: '14:00', title: '採用面接', owner: '田中 健太' }, { room: 'nishinomiya5', start: '15:30', end: '16:30', title: 'OB訪問対応', owner: '渡辺 さゆり' }, { room: 'fukuda2', start: '16:00', end: '17:00', title: '引き渡し前確認', owner: '鈴木 花子' }],
  '2026-07-07': [{ room: 'nishinomiya3', start: '08:00', end: '09:00', title: 'クレーム対応会議', owner: '小林 勇人' }, { room: 'fukuda2', start: '08:30', end: '09:30', title: '見学会 準備', owner: '渡辺 さゆり' }, { room: 'hanahaku4', start: '12:30', end: '13:30', title: 'クレーム対応会議', owner: '山本 大輔' }, { room: 'nakamozu2', start: '13:30', end: '14:30', title: '工程確認', owner: '林 美穂' }, { room: 'hirano6', start: '18:00', end: '18:30', title: '販促企画会議', owner: '伊藤 隆' }],
  '2026-07-08': [{ room: 'nishinomiya5', start: '10:00', end: '10:30', title: '資料作成', owner: '伊藤 隆' }, { room: 'nakamozu1', start: '11:30', end: '12:30', title: '施工打合せ', owner: '伊藤 隆' }],
  '2026-07-09': [{ room: 'hirano8', start: '11:00', end: '11:30', title: '社内勉強会', owner: '松本 恵' }, { room: 'hirano4', start: '16:00', end: '17:30', title: 'クレーム対応会議', owner: '加藤 剛' }, { room: 'nishinomiya1', start: '17:30', end: '18:00', title: '引き渡し前確認', owner: '渡辺 さゆり' }],
  '2026-07-10': [{ room: 'hirano6', start: '10:30', end: '11:30', title: '採用面接', owner: '田中 健太' }, { room: 'nishinomiya8', start: '14:30', end: '15:00', title: '販促企画会議', owner: '加藤 剛' }, { room: 'nishinomiya2', start: '14:30', end: '15:00', title: '販促企画会議', owner: '伊藤 隆' }],
  '2026-07-11': [{ room: 'nakamozu6', start: '11:00', end: '11:30', title: '工程確認', owner: '田中 健太' }, { room: 'nakamozu2', start: '16:30', end: '18:00', title: '契約打合せ', owner: '林 美穂' }, { room: 'hirano1', start: '16:30', end: '17:30', title: '採用面接', owner: '木村 修' }, { room: 'hanahaku3', start: '19:30', end: '20:30', title: '安全大会 準備', owner: '松本 恵' }, { room: 'nakamozu3', start: '20:00', end: '21:00', title: '現地調査 打合せ', owner: '林 美穂' }],
  '2026-07-12': [{ room: 'hirano9', start: '09:30', end: '10:30', title: '資料作成', owner: '松本 恵' }, { room: 'fukuda2', start: '19:30', end: '20:00', title: '施工打合せ', owner: '加藤 剛' }],
  '2026-07-13': [{ room: 'hirano8', start: '11:00', end: '11:30', title: '引き渡し前確認', owner: '田中 健太' }, { room: 'nishinomiya4', start: '11:30', end: '12:00', title: '協力会社 打合せ', owner: '小林 勇人' }, { room: 'nishinomiya7', start: '12:00', end: '12:30', title: '来客対応', owner: '吉田 亮' }, { room: 'nishinomiya8', start: '15:30', end: '16:00', title: '契約打合せ', owner: '吉田 亮' }],
  '2026-07-14': [{ room: 'hirano4', start: '12:30', end: '13:30', title: '安全大会 準備', owner: '中村 由美' }, { room: 'hanahaku2', start: '17:00', end: '17:30', title: '協力会社 打合せ', owner: '田中 健太' }],
  '2026-07-15': [{ room: 'hanahaku5', start: '17:30', end: '18:30', title: '見積レビュー', owner: '高橋 直子' }],
  '2026-07-16': [{ room: 'nakamozu4', start: '15:30', end: '16:30', title: '来客対応', owner: '木村 修' }, { room: 'hirano5', start: '17:30', end: '18:30', title: '資料作成', owner: '伊藤 隆' }],
  '2026-07-17': [{ room: 'nakamozu3', start: '14:30', end: '15:30', title: '採用面接', owner: '中村 由美' }, { room: 'hirano1', start: '15:00', end: '16:30', title: 'クレーム対応会議', owner: '高橋 直子' }, { room: 'nishinomiya4', start: '16:00', end: '17:00', title: '来客対応', owner: '中村 由美' }, { room: 'fukuda2', start: '17:00', end: '17:30', title: '来客対応', owner: '吉田 亮' }, { room: 'hanahaku4', start: '17:30', end: '19:00', title: '安全大会 準備', owner: '林 美穂' }],
  '2026-07-18': [{ room: 'hanahaku2', start: '13:00', end: '14:30', title: '打合せ', owner: '小林 勇人' }],
  '2026-07-19': [{ room: 'nishinomiya5', start: '09:00', end: '09:30', title: '見積レビュー', owner: '佐藤 誠' }, { room: 'hanahaku5', start: '14:00', end: '15:00', title: '契約打合せ', owner: '吉田 亮' }, { room: 'nakamozu3', start: '19:00', end: '20:00', title: '朝礼・KY活動', owner: '加藤 剛' }],
  '2026-07-20': [{ room: 'nishinomiya4', start: '12:30', end: '13:30', title: '販促企画会議', owner: '吉田 亮' }, { room: 'nakamozu4', start: '13:00', end: '14:00', title: '契約打合せ', owner: '伊藤 隆' }, { room: 'nishinomiya8', start: '17:30', end: '18:00', title: '引き渡し前確認', owner: '林 美穂' }, { room: 'nishinomiya2', start: '18:00', end: '19:30', title: '安全大会 準備', owner: '小林 勇人' }],
  '2026-07-21': [{ room: 'nakamozu5', start: '12:30', end: '14:00', title: 'クレーム対応会議', owner: '中村 由美' }, { room: 'nakamozu3', start: '15:00', end: '16:00', title: '見学会 準備', owner: '木村 修' }, { room: 'nishinomiya8', start: '15:00', end: '16:00', title: '朝礼・KY活動', owner: '佐藤 誠' }, { room: 'hirano9', start: '16:00', end: '17:30', title: '引き渡し前確認', owner: '佐藤 誠' }],
  '2026-07-22': [{ room: 'hanahaku2', start: '08:30', end: '09:30', title: '引き渡し前確認', owner: '渡辺 さゆり' }, { room: 'hanahaku3', start: '12:30', end: '13:00', title: '安全大会 準備', owner: '田中 健太' }, { room: 'nakamozu2', start: '17:30', end: '18:00', title: '安全大会 準備', owner: '木村 修' }, { room: 'hirano5', start: '18:30', end: '19:30', title: 'クレーム対応会議', owner: '高橋 直子' }],
  '2026-07-23': [{ room: 'nishinomiya4', start: '18:30', end: '19:00', title: '朝礼・KY活動', owner: '伊藤 隆' }],
  '2026-07-24': [{ room: 'nishinomiya1', start: '12:00', end: '12:30', title: '朝礼・KY活動', owner: '渡辺 さゆり' }, { room: 'hirano3', start: '19:30', end: '20:30', title: '見学会 準備', owner: '林 美穂' }],
  '2026-07-25': [{ room: 'hirano6', start: '11:30', end: '12:30', title: 'クレーム対応会議', owner: '松本 恵' }, { room: 'hirano3', start: '12:00', end: '13:00', title: '朝礼・KY活動', owner: '伊藤 隆' }],
  '2026-07-26': [{ room: 'hanahaku4', start: '17:00', end: '17:30', title: '安全パトロール前ミーティング', owner: '吉田 亮' }, { room: 'hirano7', start: '18:00', end: '19:00', title: '商談', owner: '松本 恵' }],
  '2026-07-27': [{ room: 'nishinomiya3', start: '13:00', end: '13:30', title: '商談', owner: '松本 恵' }, { room: 'hirano3', start: '14:00', end: '15:30', title: '安全大会 準備', owner: '吉田 亮' }, { room: 'nakamozu6', start: '17:00', end: '17:30', title: '安全大会 準備', owner: '木村 修' }, { room: 'nishinomiya5', start: '18:30', end: '20:00', title: '週次会議', owner: '林 美穂' }],
  '2026-07-28': [{ room: 'nishinomiya9', start: '10:30', end: '11:30', title: '工程確認', owner: '山本 大輔' }, { room: 'nakamozu6', start: '15:30', end: '17:00', title: '週次会議', owner: '渡辺 さゆり' }, { room: 'nakamozu3', start: '19:30', end: '20:00', title: '週次会議', owner: '小林 勇人' }],
  '2026-07-29': [{ room: 'hirano5', start: '12:30', end: '14:00', title: '社内勉強会', owner: '小林 勇人' }, { room: 'hanahaku7', start: '15:30', end: '17:00', title: '引き渡し前確認', owner: '松本 恵' }],
  '2026-07-30': [{ room: 'nishinomiya5', start: '10:30', end: '11:30', title: '施工打合せ', owner: '中村 由美' }, { room: 'hanahaku3', start: '15:00', end: '16:00', title: '個別面談', owner: '田中 健太' }],
  '2026-07-31': [{ room: 'nishinomiya4', start: '19:00', end: '19:30', title: '工程確認', owner: '山本 大輔' }],
  '2026-08-01': [{ room: 'nakamozu2', start: '13:00', end: '14:00', title: '契約打合せ', owner: '鈴木 花子' }, { room: 'nakamozu5', start: '15:30', end: '16:30', title: '週次会議', owner: '加藤 剛' }],
  '2026-08-02': [{ room: 'nishinomiya7', start: '10:30', end: '12:00', title: '見学会 準備', owner: '渡辺 さゆり' }, { room: 'nishinomiya9', start: '12:00', end: '12:30', title: '採用面接', owner: '山本 大輔' }, { room: 'hanahaku6', start: '17:30', end: '18:30', title: '個別面談', owner: '加藤 剛' }, { room: 'nakamozu2', start: '18:30', end: '19:30', title: '個別面談', owner: '鈴木 花子' }, { room: 'hanahaku2', start: '20:00', end: '21:00', title: '引き渡し前確認', owner: '山本 大輔' }],
  '2026-08-03': [{ room: 'hirano8', start: '08:00', end: '09:00', title: '現地調査 打合せ', owner: '田中 健太' }, { room: 'hanahaku4', start: '17:00', end: '18:30', title: '引き渡し前確認', owner: '渡辺 さゆり' }],
  '2026-08-04': [{ room: 'nishinomiya8', start: '09:00', end: '09:30', title: '契約打合せ', owner: '佐藤 誠' }, { room: 'hanahaku1', start: '19:30', end: '20:00', title: '見学会 準備', owner: '佐藤 誠' }, { room: 'nishinomiya5', start: '19:30', end: '20:30', title: '引き渡し前確認', owner: '林 美穂' }],
  '2026-08-05': [{ room: 'hanahaku3', start: '08:00', end: '09:00', title: '安全大会 準備', owner: '伊藤 隆' }, { room: 'hanahaku7', start: '12:00', end: '13:00', title: '見学会 準備', owner: '山本 大輔' }],
  '2026-08-06': [{ room: 'hanahaku5', start: '10:30', end: '12:00', title: '朝礼・KY活動', owner: '林 美穂' }, { room: 'hirano6', start: '12:00', end: '13:00', title: '現地調査 打合せ', owner: '吉田 亮' }, { room: 'hanahaku2', start: '15:30', end: '16:30', title: '見積レビュー', owner: '伊藤 隆' }, { room: 'hirano9', start: '18:30', end: '19:00', title: '安全パトロール前ミーティング', owner: '伊藤 隆' }],
  '2026-08-07': [{ room: 'hirano3', start: '18:00', end: '19:00', title: '見積レビュー', owner: '高橋 直子' }],
  '2026-08-08': [{ room: 'nishinomiya7', start: '08:00', end: '09:00', title: '資料作成', owner: '高橋 直子' }],
  '2026-08-09': [{ room: 'nishinomiya9', start: '11:00', end: '12:00', title: '個別面談', owner: '田中 健太' }, { room: 'hanahaku5', start: '13:30', end: '14:30', title: 'OB訪問対応', owner: '吉田 亮' }, { room: 'nakamozu6', start: '14:00', end: '14:30', title: '見学会 準備', owner: '田中 健太' }],
  '2026-08-10': [{ room: 'nakamozu2', start: '10:00', end: '11:00', title: '契約打合せ', owner: '中村 由美' }, { room: 'hirano3', start: '14:30', end: '16:00', title: '契約打合せ', owner: '林 美穂' }],
  '2026-08-11': [{ room: 'hirano5', start: '10:00', end: '11:30', title: 'OB訪問対応', owner: '松本 恵' }, { room: 'nakamozu2', start: '15:00', end: '16:00', title: '見積レビュー', owner: '中村 由美' }, { room: 'nishinomiya8', start: '16:30', end: '17:30', title: 'OB訪問対応', owner: '渡辺 さゆり' }, { room: 'hanahaku4', start: '16:30', end: '18:00', title: '施工打合せ', owner: '林 美穂' }],
  '2026-08-12': [{ room: 'nakamozu4', start: '09:30', end: '10:30', title: '安全パトロール前ミーティング', owner: '松本 恵' }, { room: 'hirano1', start: '09:30', end: '10:30', title: '協力会社 打合せ', owner: '中村 由美' }, { room: 'nishinomiya6', start: '10:00', end: '11:30', title: '社内勉強会', owner: '松本 恵' }, { room: 'hirano9', start: '10:00', end: '11:00', title: 'OB訪問対応', owner: '山本 大輔' }, { room: 'nakamozu6', start: '16:00', end: '17:00', title: '契約打合せ', owner: '木村 修' }],
  '2026-08-13': [{ room: 'nishinomiya9', start: '09:30', end: '10:00', title: '現地調査 打合せ', owner: '鈴木 花子' }],
  '2026-08-14': [{ room: 'hanahaku7', start: '09:00', end: '10:00', title: '来客対応', owner: '佐藤 誠' }, { room: 'hanahaku5', start: '10:30', end: '11:00', title: '社内勉強会', owner: '加藤 剛' }],
  '2026-08-15': [{ room: 'nishinomiya5', start: '10:00', end: '11:00', title: '見積レビュー', owner: '小林 勇人' }, { room: 'nishinomiya8', start: '10:30', end: '12:00', title: '採用面接', owner: '佐藤 誠' }, { room: 'hanahaku1', start: '18:00', end: '18:30', title: '打合せ', owner: '渡辺 さゆり' }, { room: 'hirano3', start: '18:30', end: '20:00', title: '協力会社 打合せ', owner: '小林 勇人' }, { room: 'nishinomiya3', start: '19:30', end: '21:00', title: '見積レビュー', owner: '山本 大輔' }],
  '2026-08-16': [{ room: 'hirano8', start: '08:30', end: '09:00', title: '現地調査 打合せ', owner: '吉田 亮' }, { room: 'nakamozu2', start: '10:30', end: '11:30', title: '個別面談', owner: '高橋 直子' }, { room: 'nishinomiya7', start: '12:00', end: '13:00', title: '工程確認', owner: '林 美穂' }, { room: 'hanahaku5', start: '15:00', end: '16:00', title: '見積レビュー', owner: '松本 恵' }],
  '2026-08-17': [{ room: 'hirano6', start: '08:30', end: '10:00', title: '見積レビュー', owner: '佐藤 誠' }, { room: 'hirano4', start: '11:30', end: '12:30', title: '週次会議', owner: '鈴木 花子' }, { room: 'hanahaku6', start: '19:00', end: '20:30', title: '採用面接', owner: '山本 大輔' }],
  '2026-08-18': [{ room: 'hanahaku1', start: '13:00', end: '14:30', title: '引き渡し前確認', owner: '木村 修' }],
  '2026-08-19': [{ room: 'hirano7', start: '12:30', end: '13:00', title: '見学会 準備', owner: '松本 恵' }, { room: 'nakamozu3', start: '13:00', end: '14:00', title: '工程確認', owner: '鈴木 花子' }, { room: 'hanahaku2', start: '14:00', end: '15:00', title: '施工打合せ', owner: '鈴木 花子' }],
  '2026-08-20': [{ room: 'nishinomiya8', start: '13:30', end: '15:00', title: '打合せ', owner: '渡辺 さゆり' }],
  '2026-08-21': [{ room: 'nishinomiya1', start: '09:00', end: '10:00', title: 'OB訪問対応', owner: '林 美穂' }, { room: 'hanahaku2', start: '16:30', end: '17:00', title: '安全大会 準備', owner: '伊藤 隆' }, { room: 'hanahaku4', start: '19:00', end: '20:00', title: '採用面接', owner: '林 美穂' }],
  '2026-08-22': [{ room: 'nishinomiya9', start: '11:00', end: '11:30', title: '引き渡し前確認', owner: '小林 勇人' }, { room: 'hanahaku5', start: '13:30', end: '14:30', title: '協力会社 打合せ', owner: '中村 由美' }, { room: 'hanahaku2', start: '14:00', end: '15:00', title: '週次会議', owner: '木村 修' }, { room: 'nakamozu5', start: '17:30', end: '18:30', title: 'クレーム対応会議', owner: '高橋 直子' }, { room: 'nakamozu4', start: '19:30', end: '20:00', title: '資料作成', owner: '佐藤 誠' }],
  '2026-08-23': [{ room: 'hanahaku4', start: '09:30', end: '10:00', title: '施工打合せ', owner: '鈴木 花子' }, { room: 'nishinomiya5', start: '11:00', end: '12:30', title: '引き渡し前確認', owner: '木村 修' }, { room: 'hanahaku2', start: '13:00', end: '14:00', title: '工程確認', owner: '林 美穂' }, { room: 'nishinomiya4', start: '14:00', end: '14:30', title: '安全大会 準備', owner: '松本 恵' }]
};

/** 指定会議室・日付の予約一覧(開始時刻順)。純粋関数。
    2026-07-01〜2026-08-23: 上記の固定サンプルのみ(操作不可・実予約は反映しない)。
    2026-08-24以降: 実予約(サーバー保存)のみ(曜日パターンのダミーは適用しない)。
    それより前(2026-06-30以前): 従来どおり曜日パターン + 実予約。 */
function bookingsFor(roomId, date, extraBookings) {
  const key = isoDate(date);
  if (key >= SAMPLE_HISTORY_START && key <= SAMPLE_HISTORY_END) {
    return (SAMPLE_HISTORY[key] || []).filter(b => b.room === roomId).sort((x, y) => x.start.localeCompare(y.start));
  }
  const own = (extraBookings || [])
    .filter(b => b.room === roomId && b.date === key)
    .map(b => ({ ...b, user: true }));
  if (key > SAMPLE_HISTORY_END) {
    return own.sort((x, y) => x.start.localeCompare(y.start));
  }
  const dow = date.getDay();
  const base = (dow === 0 || dow === 6) ? [] :
    (PATTERNS[roomId] || []).filter(p => p.dow === dow).map(p => ({ ...p }));
  return base.concat(own).sort((x, y) => x.start.localeCompare(y.start));
}
