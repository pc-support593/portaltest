# 吉村一建設 社内ポータル

社員が朝一番に開く社内ポータル。Claude Design で作成したデザインハンドオフ
([design/README.md](design/README.md))を移植したもの。3画面構成。

| 画面 | URL | 内容 |
|---|---|---|
| ポータル トップ | `/`(index.html) | お知らせ・クイックリンク・今日の予定・全社スケジュール・タスク承認待ち |
| 会議室予約 | `/rooms.html` | 展示場(拠点)別・会議室別の月間カレンダー、予約の作成/変更/取消、CSV出力(**サンプル表示**。Exchangeの会議室リソース未整備のためダミーデータのまま。実際にはOutlookへ反映されない) |
| **スケジュール** | `/schedule.html` | 個人の1日のスケジュール(**実データ**。Graph `/me/calendarView`・`/me/events`)+ 拠点別 会議室のスケジュール(サンプル表示、rooms.htmlと同じダミーデータ)。会議室を含まない予定(件名・時間・任意の場所/参加者)を作成すると実際にOutlookへ反映される |
| 管理画面 | `/admin.html` | お知らせ / 全社スケジュール / クイックリンクの CRUD(要 Portal.Admin ロール) |

## 起動方法

```powershell
cd Portal
npm install   # 初回のみ(express のみ)
npm start     # http://localhost:3100
```

- Node.js 24以上(DB は標準モジュール `node:sqlite` を使用、ネイティブ依存なし)
- データは `data/portal.db`(SQLite・初回起動時に自動作成、ダミーデータをシード)

## 現在の状態

- 認証: `.env` で dev(モックユーザー「佐藤 美咲」)/ entra(Entra IDサインイン)を切替(`.env.example` 参照、手順は [docs/entra-setup.md](docs/entra-setup.md))。起動ログの「認証: dev / entra」で現在のモードを確認できる
- **entraモードで実データ連携済み**: ポータルトップの「今日の予定」、スケジュール画面の「個人のスケジュール」(表示は `Calendars.Read`、作成は `Calendars.ReadWrite` が必要)。会議室を含まない予定を作成すると本当にOutlookに反映される
- サーバー保存(SQLite): お知らせ・全社スケジュール・クイックリンク・会議室予約(サンプル)
- 会議室予約は**サンプル表示のまま**(Exchangeの会議室リソース未整備のため)。自分(モックユーザー)の予約シードは実データとしてDBに保存され、カレンダーの黄色バー「主催」チップや日別ポップアップから変更・取消できる
- ダミー(MS365連携までの仮): 拠点・会議室マスタ、曜日パターンの他人の予約、タスク・承認待ち、社内メンバー検索の名簿

## 構成

```
Portal/
├── server.js          # Express: 静的配信 + CRUD API(ポート3100)
├── src/db.js          # SQLiteスキーマ + シード
├── public/
│   ├── index.html / rooms.html / admin.html / schedule.html
│   ├── css/portal.css                         # 基礎スタイル + hover/focus
│   └── js/
│       ├── common.js     # esc / api / ユーザー表示
│       ├── auth.js       # 認証アダプタ(dev | entra)+ Graphトークン取得
│       ├── portal.js     # トップ画面(今日の予定は実データ)
│       ├── roomsData.js  # 拠点・会議室マスタ + ダミー予約パターン(rooms.js/schedule.js共有)
│       ├── rooms.js      # 会議室予約(サンプル表示。カレンダー・予約フォーム・CSV出力)
│       ├── schedule.js   # スケジュール画面(個人=実データ、拠点別会議室=サンプル)
│       └── admin.js      # 管理画面 CRUD
├── docs/entra-setup.md  # Entra ID アプリ登録〜Graph API 移行手順
└── design/              # デザインハンドオフ(README + プロトタイプZIP + 抽出ソース)
```

## デザインとの関係

- `design/README.md` がハンドオフ仕様(色・タイポグラフィ・挙動の確定値)。**実装はこれを正とする**
- `design/社内ポータルのホームページ構成.zip` 内のプロトタイプHTMLはREADMEより古い版
  (CSV出力・社内メンバー検索・主催/参加バッジ・新規予約ボタンが無い)。視覚リファレンスとして利用
- `design/reference/` はプロトタイプから抽出した素のマークアップ・ロジック(移植時の参照用)
