// SQLite(node:sqlite 標準モジュール)のスキーマ定義とシード
// 管理画面のコンテンツ(お知らせ・全社スケジュール・クイックリンク)と
// ユーザー作成の会議室予約を保存する。WALモード(webinputsystemと同方式)。
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'portal.db');

function open() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  seed(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS news (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tag TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      sub TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      char TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT NOT NULL,
      date TEXT NOT NULL,            -- ISO 8601 (YYYY-MM-DD)
      start TEXT NOT NULL,           -- HH:MM
      end TEXT NOT NULL,             -- HH:MM
      title TEXT NOT NULL,
      owner TEXT NOT NULL,           -- 主催者の表示名(表示用)
      owner_email TEXT NOT NULL DEFAULT '', -- 主催者の同一性判定はこちら(同姓同名対策。Entra移行後はUPN)
      members TEXT NOT NULL DEFAULT '[]', -- 社内メンバー JSON [{name, dept, email}]
      guests TEXT NOT NULL DEFAULT '',    -- 外部参加者(自由入力)
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date);
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      dept TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS user_layouts (
      email TEXT PRIMARY KEY,        -- ユーザーの同一性はメールで判定(bookingsと同方式)
      layout TEXT NOT NULL,          -- JSON { left: [sectionId...], right: [sectionId...] }
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // 既存DB向けの後方互換マイグレーション
  try { db.exec("ALTER TABLE bookings ADD COLUMN owner_email TEXT NOT NULL DEFAULT ''"); } catch { /* 追加済み */ }
}

// デザインハンドオフのダミーデータをそのまま初期値として投入(初回のみ)
function seed(db) {
  const count = t => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;

  if (count('news') === 0) {
    const ins = db.prepare('INSERT INTO news (tag, title, date, body) VALUES (?, ?, ?, ?)');
    [
      ['重要', '夏季休業期間のお知らせ(8/11〜8/15)', '2026-07-17',
        '本年度の夏季休業期間は 8月11日(火)〜8月15日(土) の5日間です。\n\n・休業中の緊急連絡は総務部 内線100(転送対応)まで\n・現場の稼働予定は各工事部長の指示に従ってください\n・休業前日の 8/10 は 16:00 までに戸締り・電源確認をお願いします\n\n休暇申請システムへの入力は不要です。'],
      ['総務', '健康診断の予約受付を開始しました', '2026-07-16',
        '本社・各営業所の定期健康診断の予約受付を開始しました。\n\n実施期間: 7月28日(火)〜8月8日(土)\n会場: 本社2F 多目的室(営業所は巡回健診車)\n\n予約はポータルの「健康診断予約」リンク、または総務部 内線102 まで。受診時は保険証と問診票をご持参ください。'],
      ['安全', '7月度 安全衛生委員会の議事録を掲載', '2026-07-15',
        '7月度 安全衛生委員会(7/14 開催)の議事録を社内ドキュメントに掲載しました。\n\n主な議題:\n・熱中症対策の徹底(WBGT値の測定と休憩ルール)\n・○○現場での指摘事項と是正状況\n・保護具の点検・交換スケジュール\n\n各現場責任者は朝礼での周知をお願いします。'],
      ['人事', '中途入社者のご紹介(工事部 2名)', '2026-07-14',
        '7月1日付で工事部に2名が入社しました。\n\n・佐藤 健一(施工管理・経験12年)\n・田中 美咲(積算・経験5年)\n\n配属は本社工事部です。見かけた際はぜひお声がけください。歓迎会は 7/31(金) を予定しています。'],
      ['IT', '社内Wi-Fi機器更新に伴う一時停止(7/26 夜間)', '2026-07-11',
        '社内Wi-Fi機器の更新作業のため、下記の時間帯は本社の無線LANが利用できません。\n\n停止日時: 7月26日(日) 22:00〜翌 5:00\n影響範囲: 本社全フロアの Wi-Fi(有線LANは利用可)\n\n作業完了後、接続に問題がある場合は情報システム課 内線205 までご連絡ください。']
    ].forEach(r => ins.run(...r));
  }

  if (count('schedule') === 0) {
    const ins = db.prepare('INSERT INTO schedule (date, title, sub, body) VALUES (?, ?, ?, ?)');
    [
      ['2026-07-24', '全社朝会(オンライン配信)', '9:00– 全社員',
        '月例の全社朝会をオンライン配信で実施します。\n\n・社長メッセージ\n・各部門トピックス\n・安全表彰\n\n現場からはモバイル端末での視聴が可能です。'],
      ['2026-08-01', '創立記念日(休業日)', '全社休業',
        '8月1日は創立記念日のため全社休業です。緊急連絡は総務部 内線100(転送対応)までお願いします。'],
      ['2026-08-20', '下期キックオフ総会', '本社ホール / 配信あり',
        '下期方針の共有と部門目標の発表を行います。\n\n会場: 本社1Fホール(オンライン配信あり)\n時間: 15:00〜17:00\n\n終了後、懇親会を予定しています。'],
      ['2026-09-05', '全社防災訓練', '各拠点 10:00–',
        '全拠点一斉の防災訓練を実施します。\n\n・避難経路の確認と避難訓練\n・安否確認システムの応答訓練\n\n現場は各現場の避難計画に基づき実施してください。']
    ].forEach(r => ins.run(...r));
  }

  if (count('links') === 0) {
    const ins = db.prepare('INSERT INTO links (char, label, url) VALUES (?, ?, ?)');
    [
      ['勤', '勤怠管理', '#'],
      ['経', '経費精算', '#'],
      ['申', '各種申請', '#'],
      ['会', '会議室予約', 'rooms.html'],
      ['工', '工事台帳', '#'],
      ['図', '図面管理', '#'],
      ['名', '社員名簿', '#'],
      ['IT', 'ITサポート', '#']
    ].forEach(r => ins.run(...r));
  }

  // モックユーザー自身の予約デモ(初回のみ)。実データとして保存するので編集・削除が可能。
  // ※他人の予約デモは rooms.js の PATTERNS(クライアント側の擬似データ)のまま
  if (count('users') === 0 && count('bookings') === 0) {
    const series = [
      { room: 'a', dow: 1, start: '10:00', end: '11:00', title: '営業企画 定例MTG' },
      { room: 'b', dow: 5, start: '16:00', end: '17:00', title: '週次レビュー' },
      { room: 'os2', dow: 5, start: '13:00', end: '14:00', title: '本社定例(TV会議)' }
    ];
    const ins = db.prepare(
      'INSERT INTO bookings (room, date, start, end, title, owner, owner_email) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const pad = n => String(n).padStart(2, '0');
    const today = new Date();
    // 2週間前〜6週間後の該当曜日に展開
    for (let off = -14; off <= 42; off++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + off);
      const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      series.filter(s => s.dow === d.getDay()).forEach(s => {
        ins.run(s.room, iso, s.start, s.end, s.title, '佐藤 美咲', 'm-sato@yoshimuraichi.com');
      });
    }
  }

  if (count('users') === 0) {
    const ins = db.prepare('INSERT INTO users (name, dept, email) VALUES (?, ?, ?)');
    [
      ['佐藤 美咲', '営業企画部', 'm-sato@yoshimuraichi.com'],
      ['田中 健太', '工事部', 'k-tanaka@yoshimuraichi.com'],
      ['鈴木 花子', '総務部', 'h-suzuki@yoshimuraichi.com'],
      ['佐藤 健一', '工事部', 'k-sato@yoshimuraichi.com'],
      ['田中 美咲', '工事部(積算)', 'm-tanaka@yoshimuraichi.com'],
      ['山本 大輔', '営業部', 'd-yamamoto@yoshimuraichi.com'],
      ['中村 由美', '人事部', 'y-nakamura@yoshimuraichi.com'],
      ['小林 誠', '情報システム課', 'm-kobayashi@yoshimuraichi.com'],
      ['加藤 剛', '安全衛生委員会', 't-kato@yoshimuraichi.com'],
      ['渡辺 恵', '経理部', 'm-watanabe@yoshimuraichi.com'],
      ['伊藤 隆', '大阪支店 営業', 't-ito@yoshimuraichi.com'],
      ['高橋 直子', '大阪支店 工事', 'n-takahashi@yoshimuraichi.com'],
      ['木村 修', '仙台営業所', 'o-kimura@yoshimuraichi.com'],
      ['林 美穂', '積算課', 'm-hayashi@yoshimuraichi.com'],
      ['吉田 亮', '工事部', 'r-yoshida@yoshimuraichi.com']
    ].forEach(r => ins.run(...r));
  }
}

module.exports = { open, DB_PATH };
