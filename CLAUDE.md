# 社内ポータル(Portal)

## 概要

社員向け社内ポータル。5画面: ポータルトップ(お知らせ・クイックリンク・予定)/ 会議室予約(拠点別カレンダー。**2026-07-01〜08-23はデザインサンプル、2026-08-24以降はentraモードで実際のExchange連携**)/ スケジュール(個人 + 拠点別会議室、**両方実データ**)/ 組織図(部門別メンバー一覧。**実データ=Entra ID**。2026-08-22追加)/ 管理画面(コンテンツCRUD)。
Claude Design のハンドオフ([design/README.md](design/README.md))を移植。**統括方針「Entra ID SSO + ポータル」構成のMS365実環境検証が目的**(→ ベンダー要件提示の説得材料)。Entra IDアプリ登録・サインイン・Graphでの個人予定連携・**実際のExchange会議室リソースとの連携は実装済み・稼働中**。

## 技術スタック

- Node.js >= 24、Express 4、素のHTML/CSS/JS(ビルド工程なし)
- DB: `node:sqlite`(標準モジュール、WALモード)→ `data/portal.db`(webinputsystemと同方式)
- ポート: **3100**(webinputsystem が 3000 のため)
- 認証: `.env` で `AUTH_MODE=dev|entra` を切替(`.env.example` 参照)。entraモードはEntra ID(MSAL.js)+ サーバー側トークン検証(`jose`)。手順・権限は [docs/entra-setup.md](docs/entra-setup.md)
- Graph呼び出しは**ブラウザから直接**(`Auth.getGraphToken(scopes)`)。サーバーはポータル自前APIの認可のみ行い、Graphのアクセストークンを中継しない(シークレットレス設計を維持するため)

## 主要ファイル

- `server.js` — 全API(config/me/content/admin CRUD/users検索/bookings CRUD/layout)+ 静的配信 + entraモードのトークン検証
- `src/db.js` — スキーマ + ハンドオフ準拠のシードデータ
- `public/js/roomsData.js` — **拠点・会議室マスタの単一の正**(実際のExchange会議室リソース。5拠点33室・email付き)。`rooms.js` と `schedule.js` の両方が読み込む(schedule.htmlとrooms.htmlの両方でscriptタグ読込。マスタが増減したらここ1箇所を直す)。あわせて `rooms.js` 用のダミー予約データと純粋関数 `bookingsFor(roomId, date, extraBookings)`、および`rooms.js`/`schedule.js`共用の`encodeEventBody(content, guests)`/`decodeEventBody(bodyText)`(予定本文=内容+外部参加者の相互変換。2026-08-22追加)を持つ。**schedule.js側で同名のconst(SITES/ROOMS等)を再宣言しないこと**(グローバル衝突でSyntaxErrorになる)。`bookingsFor` の期間別の返り値(ユーザー指示・2026-08-21):
  - **〜2026-06-30**: 曜日パターンのダミー `PATTERNS` + 実予約(サーバーSQLite)
  - **2026-07-01〜2026-08-23**: `SAMPLE_HISTORY`(1日1〜5件・固定シードで一度だけ生成したフローズンなランダムサンプル。再生成しない)**のみ**。実予約は反映せず、`rooms.js`側のフォームでも予約操作不可(`formError`でブロック)
  - **2026-08-24〜**: `rooms.js`が渡す`extraBookings`次第(下記参照)。entraモードなら実際のExchange予約、devモードならサーバーSQLite保存のサンプル動作
- `public/js/rooms.js` — 会議室予約の全ロジック(カレンダー、予約フォーム、CSV出力)。**URLパラメータで表示対象を切り替える共通ページ**(2026-08-22共通化。冒頭の`VIEW`と`V_SITES`/`V_ROOMS`/`V_SITE_LABEL`/`V_ITEM_LABEL`/`V_UNIT`/`vSiteRooms`/`vRoomById`/`viewBookingsFor`で抽象化。画面表示文言(「会議室」⇄「社用車」「室」⇄「台」等)もこれらのラベル定数経由で自動的に切り替わる):
  - `rooms.html` → **ゆめすみか展示場ビュー**(従来どおり。以下の日付分岐が適用される)
  - `rooms.html?view=yoshimura` → **吉村一建設会議室ビュー**(区分け5つ×10室。**全期間実データのみ**=サンプル期間・SQLite保存・日付分岐なし。devモードでは表示・予約とも不可でその旨を案内)
  - `rooms.html?view=cars` → **社用車ビュー**(部門6つ×9台。吉村一建設会議室ビューと同じく全期間実データのみ。2026-08-22追加)
  ゆめすみかビューの挙動: **拠点・会議室名は実際のExchange会議室(roomsData.jsのマスタ)を表示**。**2026-08-24以降の予約は、entraモードでは実際にExchangeと連携する(ユーザー指示・2026-08-21。schedule.jsと同じ`/me/events`+会議室resource出席者の仕組み。`REAL_ROOMS_ENABLED`フラグでON/OFF可)**。devモードは従来どおりサーバーSQLite保存のサンプル動作(`src/db.js`のシードもそのまま機能する)。
  - 表示: `fetchRealRoomBookings(rooms, from, to)` が対象拠点の全会議室について `GET /users/{room}/calendarView` を並行取得(会議室ごとにtry/catchし、失敗した室だけ空扱い+`state.realErrors`に記録してカレンダー下部に赤字表示)。自分の予定表(`GET /me/calendarView`)も同時に取得し、`iCalUId`+開始時刻をキーに会議室側のコピーと突き合わせて**自分の予定のID(myEventId)**を特定する(**会議室側のcalendarViewで取れるIDは会議室メールボックス側のコピーのIDで`/me/events/{id}`には使えないため**、突き合わせが必須)。自分が作成直後でまだ会議室側に反映されていない予約は「承諾待ち」(半透明+バッジ)、会議室が辞退した場合は「自動辞退」バッジで表示する
  - 編集可否: 会議室側calendarViewで得た予約は`editable`(=自分が主催者かつ繰り返しでない)でのみ変更・取消可能(**Exchangeが主催者以外の変更を拒否するため**)。サンプル・旧データ(〜8/23、devモード)は従来どおり誰でも編集可能(rule 7)
  - 作成・変更: `submitRealForm()`(`schedule.js`の`submitCreateForm`と同じ方式)。送信直前に対象会議室・日付を再取得して重複チェック、会議室を`type:"resource"`出席者として追加、`location`は`locationEmailAddress`で紐づけ(場所の二重表記対策)、`POST/PATCH /me/events`。過去日時は`formError`でブロック(Exchangeが処理しないため)
  - 削除: `DELETE /me/events/{myEventId}`(会議室側のIDではない)
  - 予約フォームは「件名」とは別に**「内容」欄(自由記述。任意)**を持つ(2026-08-22追加)。参加者は「社内メンバー」(`searchMembers`。§共通ファイル参照)と「外部参加者」(`guests`。自由入力の別枠、社外顧客等)を分けて入力する。**内容・外部参加者はどちらもExchangeの予定本文(body)1つにまとめて保存**する(`roomsData.js`の`encodeEventBody`/`decodeEventBody`で相互変換。件名と混同しないよう分離)。SQLite保存(サンプル・旧データ)の予約にも`content`列で同様に保持する
- `public/js/schedule.js` — スケジュール画面。**個人のスケジュール・拠点別の会議室スケジュールとも実データ**。
  - 個人: Graph `/me/calendarView` で表示、`/me/events` で作成
  - 会議室マスタ: ファイル冒頭の `SITES`/`ROOMS_NAMES_BY_SITE` に**実際のExchange会議室リソースをハードコード**(5拠点33室。平野9・花博7・西宮9・中百舌鳥6・福田2。ドメインは`yumesumika.com`)。マスタが増減したら Exchange 管理者に確認しこの配列を直す(`Get-Mailbox -RecipientTypeDetails RoomMailbox` で最新一覧を取得できる)。Graph `Place.Read.All` は使わない設計(ハードコード運用と決定済み)ため不要
  - 空き状況: `fetchRoomBusy()`(共通処理`fetchCalendarViewBusy`)が各会議室自身の予定表(`GET /users/{room}/calendarView`)を33室ぶん並行取得し、`state.roomBusy`(roomId→busy配列)に格納。**件名・予約者名まで表示**(2026-08-22変更。旧`getSchedule`方式=空き時間のみ取得、から切替。全会議室にReviewer権限を付与済みのため、拠点代表者(`SITE_REPS`)に限らず誰でも件名・予約者を見られる)。`getScheduleBusy`/`getSchedule`は不使用(削除済み)
  - 予約作成: 「会議室を使用する」チェック時、選択した会議室を `attendees` に `type: "resource"` で追加して `POST /me/events`。**Exchange側が空きなら自動承諾・埋まっていれば自動辞退する本物の予約**(サンプルではない。サーバー側のSQLite保存は使わない)。場所は `locationEmailAddress` で会議室本体と紐づける(文字列だけだと自動承諾時に場所が二重表記になる)
  - 重複の事前チェック: 送信直前に `fetchRoomBusy` で最新の空き状況を取り直し、重複していたら**予定自体を作らずエラー表示**(変更時は自分の元の時間帯を重複扱いしない)。すり抜けた場合の最終判定はExchange(自動辞退。ただし主催者の予定表には残る=Outlook標準挙動)
  - 会議室が未承諾の予定は「承諾待ち」バッジ+半透明で表示(calendarViewの `showAs === 'tentative'`)。全33室は `AutoAccept` + `AllowConflicts: False` 設定済み(Exchange側)
  - **既知の制約(2026-08-21確認)**: Exchange側が**過去日時の会議室予約を処理しない**(会議室が出席者として一切追加されず、空き状況取得でも常に空きのまま)。ポータル側のコードには過去日時を防ぐ処理がなく、検証時は必ず未来の時間帯で予約すること
  - 予約状況セクションには**表示切り替えタブ**(`GRID_TABS`: ゆめすみか展示場/社用車/吉村一建設会議室。2026-08-22追加)があり、**見出し(#grid-title)は選択中のタブに合わせて「(タブ名)の予約状況」に自動で切り替わる**。**初期タブはサインインドメインで決まる**(@yoshimuraichi.com→吉村一建設会議室、@yumesumika.com→ゆめすみか展示場。ユーザー指示 2026-08-22)。「社用車」は**実データ**(roomsData.jsの`CAR_GROUPS`/`CARS`=9台を`fetchCalendarViewBusy`で取得し、所有部門(総務/建築営業部/設計企画部/西宮/千早赤坂村/平野)ごとにカード表示。`carsGridHtml`。2026-08-22実装。Exchange側は備品(EquipmentMailbox)として登録済み)。「吉村一建設会議室」は**実データ**(roomsData.jsの`YOSHIMURA_GROUPS`/`YOSHIMURA_ROOMS`=10室を`fetchCalendarViewBusy`で取得し、区分け(アネックスプラザ/ゲストプラザ/本社/社長室/会長室)ごとにカード表示。`yoshimuraGridHtml`)。予約の作成・変更は`rooms.html?view=yoshimura`/`rooms.html?view=cars`(共通化した予約カレンダー)から行う。**セクション右上の予約ページへのリンク(#rooms-link)は選択中のタブに連動**(ゆめすみか→rooms.html、吉村一建設→rooms.html?view=yoshimura、社用車→rooms.html?view=cars)。ゆめすみか展示場の表示(`siteGridHtml`)はメイン画面用。**予定作成モーダルは「会議室・社用車」欄(`#f-resource-type`)でゆめすみか展示場/吉村一建設会議室/社用車のいずれかを選べる**(`RESOURCE_TYPES`。2026-08-22追加。1画面のフォームから3マスタすべて予約可能)。選択すると`freeRoomsHtml`が選択中の拠点/区分け/部門・時間帯で**空いているものだけ**をチップ表示・縦スクロール(クリックで選択、開始/終了/種別/拠点の変更に追随。ユーザー指示 2026-08-21)。**プルダウン直接選択は無し**: 「会議室」欄(表示ラベルは種別により会議室/社用車に変わる)は読み取り専用で、チップのクリックでのみ選択される(直接入力・自動選択なし。種別や拠点を切り替えると選択はクリアされる)。空き状況取得は`fetchResourceBusy`(内部で共通の`fetchCalendarViewBusy`を使用)。**時間の入力は30分単位、開始時間を選ぶと終了時間が自動で開始+1時間(上限21:00)になる**(rooms.jsのフォーム・日別ポップアップも同じ挙動。ユーザー指示 2026-08-22)。予定作成フォームは「件名」とは別に「内容」欄(自由記述・任意)を持ち(2026-08-22追加)、参加者は`rooms.js`と同様に「社内メンバー」(`searchMembers`)と「外部参加者」(自由入力)を分けて入力する。内容・外部参加者は`roomsData.js`の`encodeEventBody`/`decodeEventBody`で1つの予定本文(body)にまとめて保存・復元する
- `public/js/portal.js` — トップ画面。「今日の予定」も実データ(Graph `/me/calendarView`)。お知らせのトップ表示ルール(ユーザー指示 2026-08-21): **掲載期限(`expires`。管理画面で入力)があればその日まで表示**、未入力なら掲載日が過ぎたら非表示(日付なしは表示継続)。過去分は「すべて見る」の一覧モーダル(`openNewsListModal`。全件・新しい順)から見る。全社スケジュールは**今月分だけトップに表示**(日付なしは表示継続)し、全期間は「年間予定表」の一覧モーダル(`openScheduleListModal`。日付昇順・月ごとの見出し付き)から見る(ユーザー指示 2026-08-21)。セクション配置はドラッグ&ドロップで並び替え可能(ドラッグハンドル`.drag-handle`のみ起点、ネイティブHTML5 DnD)。並び順は`/api/layout`でユーザー単位(email)にサーバー保存し、他端末でも同じ配置になる
- `public/js/auth.js` — 認証アダプタ(MSAL.js v5、SPA + PKCE)。`getGraphToken(scopes)` でGraph用トークンを取得
- `public/js/common.js` — 全画面共通ユーティリティ(`api()` / `esc()` 等)。`searchMembers(q)`(社内メンバー検索。entraモードはGraph `/users`実データ、devモードはダミー名簿`/api/users`)を`rooms.js`と`schedule.js`で共用。`fetchDepartmentMembers(department)`(指定部署のメンバー一覧。organization.js用。2026-08-22追加)。`PORTAL_PAGES`/`searchPortalPages(q)`(ポータル内ページのタイトル・キーワード一覧と部分一致検索。2026-09-07追加。新しい画面を追加したら`PORTAL_PAGES`にも追記する)
- `public/js/portal.js` の `initHeaderSearch()` — トップ画面ヘッダーの社内検索欄(2026-09-07実装。**現状index.htmlのみ**、他画面には検索欄自体が無い)。入力(250msデバウンス)ごとに`searchPortalPages`(ページ)と`searchMembers`(人。追加のGraph権限は不要、既存の`User.Read.All`を使用)を実行し、結果をドロップダウン表示する。ページ結果はクリックでそのURLに遷移、人の結果はクリックで`mailto:`リンクを開く(メッセージング機能は無いため)。連続入力時は最新の検索以外の結果を`seq`カウンタで破棄。入力欄の外側クリック・Escapeキー・空文字で閉じる。**SharePoint等の規程・ドキュメント検索は対象外**(別途`Sites.Read.All`等の追加権限と対象サイトの確定が必要なため未実装)
- `public/organization.html` / `public/js/organization.js` — 組織図画面(2026-08-22追加)。`DEPARTMENTS`(現在は総務部のみ。増やす場合はここに追記)ごとにGraph `/users?$filter=department eq '...'`で氏名・メール・電話番号を取得して表示。devモードは非対応(案内文のみ)。自動リフレッシュはルール11に準拠

## 実装ルール

1. **デザインは design/README.md が正**(色・余白・挙動は確定値)。見た目を変えるときは必ず照合する。ZIP内プロトタイプはREADMEより古い版なので仕様の根拠にしない
2. マークアップはプロトタイプ準拠のインラインスタイル + hover/focusのみ `css/portal.css` のクラス。この方式を維持する
3. 動的テキストは必ず `esc()` を通す(XSS対策)
4. ~~実データ(Graph)とサンプル(ダミー)を画面上で必ず区別する(バッジ表示: 「Outlook 連携」「Exchange 連携」等)~~ → **2026-08-22廃止(ユーザー指示)**。index.html/rooms.html/schedule.htmlの「Outlook 連携」「Exchange 連携」バッジ(`#personal-badge`/`#site-badge`/`#exchange-badge`)と、予定作成フォームの「会議室を使用する」チェック横の「Exchange 連携」タグはすべて削除済み。実データ/サンプルの区別は、各画面の説明文(`calendarFooterHtml`のモード別注記など)でのみ行う。**今後もこの種のバッジ表示は追加しない**
5. `rooms.js`は**ユーザーの明示的な指示がない限り実データ化しない**方針だったが、2026-08-21にユーザーから明示的な指示があり、2026-08-24以降・entraモードのみ実データ化した(§主要ファイル参照)。7/1〜8/23のサンプル期間とdevモードは今後もサンプルのまま維持する
6. **サンプルデータの削除禁止(ユーザー指示・2026-08-20)**: 仮のサンプルデータ(`roomsData.js`、`src/db.js`のシード、rooms.html一式、devモードの各ダミー)は、ユーザーから明示的に依頼されない限り削除しない。リファクタリングでも実データとの並存を維持する
7. サンプル画面(rooms.html。7/1〜8/23・devモードの8/24以降)の予約は**一旦、サインイン済みなら誰でも変更・取消可能**(ユーザー指示 2026-08-20。シードされたサンプル予約も編集できるようにするため。サーバー側 `ownBooking` の主催者チェックをコメントアウト中)。**entraモードの2026-08-24以降(実データ化済み)は主催者のみに戻っている**(Exchangeが強制。rooms.jsの`editable`判定)。スケジュール画面(実データ)の変更・削除も主催者のみ(Graph/Exchange側で強制される)
8. Entra ID アプリ登録の設定を変更したら [_governance/identity/app-registrations.md](../_governance/identity/app-registrations.md) の記録も更新する(統括ルール)
9. Graph権限は都度最小限を追加する(現在: `User.Read`, `Calendars.ReadWrite`, `User.Read.All`(2026-08-22に`User.ReadBasic.All`から引き上げ。社内メンバー検索の部署表示+組織図画面の`fetchDepartmentMembers`用)、`Calendars.ReadWrite.Shared`(2026-08-22時点で用途が拡大: 拠点代表者の会議室削除機能=§12、2026-08-24以降の実予約表示・作成=rooms.js、**予約状況の全表示(件名・予約者名の取得)=schedule.jsの`fetchCalendarViewBusy`で全会議室・全社用車が対象**)、自アプリの `access_as_user`。`Place.Read.All`は不使用)。このテナントは**低リスク権限でも管理者の同意が必須**な設定になっているため、権限追加のたびに管理者に同意実行を依頼する
10. ~~社内メンバー検索(User.ReadBasic.All)は基本プロフィールのみで部署(department)は取得できない~~ → **2026-08-22廃止(ユーザー指示)**。組織図画面のため`User.Read.All`に引き上げ済み。社内メンバー検索・組織図とも部署情報を表示する
11. **自動リフレッシュの共通方針(ユーザー承認・2026-08-20)**: 動的データの表示は「2分間隔で裏側から再取得・モーダル表示中と非表示タブ(document.hidden)はスキップ・差分があるときだけ静かに差し替え(自動更新時はローディング表示を出さない)・失敗は静かに無視して次回再試行」。実装済み: portal.js(今日の予定)・schedule.js(個人+拠点別)・rooms.js(サンプル予約)・organization.js(組織図。2026-08-22追加)。**今後、動的表示を新設するときも同方針を適用する**
12. **拠点/区分け/部門代表者による予約の削除機能**: `schedule.js` 冒頭の `SITE_REPS`(ゆめすみか展示場・拠点ID→担当者メール配列)/`YOSHIMURA_REPS`(吉村一建設会議室・区分けID→担当者メール配列)/`CAR_REPS`(社用車・部門ID→担当者メール配列)を直接編集して運用する(3つとも`myAdminIdsFrom(repsMap)`という共通関数で判定)。担当グループは `resourceGridHtml`(3画面共通の描画関数。旧`siteGridHtml`/`yoshimuraGridHtml`/`carsGridHtml`を統合)に「担当」バッジ+各予約に削除ボタンが出る。**2026-08-22時点で件名・予約者名の表示自体はREPS不要で全員に見えるようになった**ため、この機能が担うのは「削除ボタンを誰に出すか」のみ。**設定・前提条件とも完了(2026-09-07確認)**: `COMMON_SITE_REPS`(k-iwatani@yumesumika.com, m-sakahara@yumesumika.com, y-nishida@yumesumika.com)を5拠点(ゆめすみか展示場)に設定。`ADMIN_ALL_EMAIL`(y-honda@yoshimuraichi.com)を3カテゴリ全グループ(5拠点+5区分け+6部門・計52会議室/社用車)に設定。Exchange側の`Add-MailboxFolderPermission ... -AccessRights Editor`(§で案内したPowerShell)も実行済み・実機で削除ボタンの動作(403エラーなし)を確認済み。**この機能は完全に稼働中**
13. **白枠(セクション)右上の操作リンク/ボタンの見た目統一(ユーザー指示・2026-08-21)**: 「すべて見る」「年間予定表」「会議室予約へ」のような各セクション右上のリンクは、`schedule.html` の「＋ 予定を作成」ボタンと同じ見た目に統一する: `border:none;background:#1e5fa8;color:#ffffff;font-weight:700;border-radius:8px;padding:8px 16px;font-size:12px;font-family:inherit`(`<a>`タグの場合は`text-decoration:none`も付ける。class`hv-btn-primary`でホバー時`#16497f`)。**今後、新しいページ・セクションを追加するときもこのボタン見た目を標準として使う**
14. **rooms.html実データ化(2026-08-24以降)のExchange側前提作業(2026-08-21指示・未実行)**: 以下2つのPowerShellコマンドをExchange管理者が実行する必要がある。実行前はentraモードで該当会議室が空表示+カレンダー下部に赤字で取得失敗を表示する(壊れず安全側に劣化)。新しいEntra/Graph権限の追加・同意は不要(Calendars.ReadWrite.Sharedは既に許可済み)
    - ① 全社員が全会議室カレンダーを詳細付きで参照できるようにする(件名・主催者の取得に必須。EditorではなくReviewer=参照のみ。§12のEditor権限とは別物・独立): `Get-Mailbox -RecipientTypeDetails RoomMailbox -ResultSize Unlimited | ForEach-Object { Set-MailboxFolderPermission -Identity "$($_.PrimarySmtpAddress):\Calendar" -User Default -AccessRights Reviewer }`
    - ② 会議室の自動承諾時に件名を主催者名で上書きしないようにする(既定は`DeleteSubject`/`AddOrganizerToSubject`/`DeleteComments`が全て`$true`で件名が主催者名に置き換わり本文も消える。①だけでは望む表示にならず②も必須。**遡及しない**=実行前に自動承諾済みの予定は件名が既に上書きされたまま): `Get-Mailbox -RecipientTypeDetails RoomMailbox -ResultSize Unlimited | ForEach-Object { Set-CalendarProcessing -Identity $_.PrimarySmtpAddress -DeleteSubject $false -AddOrganizerToSubject $false -DeleteComments $false }`
    - **プライバシー影響**: ①適用後は全社員が全会議室の予定の件名・主催者・出席者を参照可能になる(今回の要望どおりだが確認済みであることの記録)
    - ①の副作用: `schedule.js`の`getSchedule`でも件名表示が改善される場合がある(既存の「件名は表示されない場合がある」の状況が緩和される)

## 今後のロードマップ(統括計画)

1. ✅ プロジェクト化・devモードで4画面稼働
2. ✅ テスト用 Entra ID アプリ登録(台帳記録: Yoshimura-Portal)
3. ✅ MSALログイン有効化(`AUTH_MODE=entra`)+ サーバー側トークン検証(jose)
4. ✅ 個人の予定表連携(表示: `/me/calendarView`、作成: `/me/events`。会議室を含まない予定のみ)
5. ✅ 会議室の実データ化(`schedule.js`。5拠点33室の実Exchangeリソース+`getSchedule`+resource出席者予約)。`rooms.js`も2026-08-24以降・entraモードで実データ化済み(2026-08-21指示。§14のExchange側前提作業は未実行)。7/1〜8/23とdevモードはデザインサンプルのまま維持
6. ✅ 社内メンバー検索の実データ化(`User.ReadBasic.All` + Graph `/users`。**Azure側でのAPI権限追加+管理者同意が未実施の場合は動作しない**。§0参照)
7. webinputsystem(経費精算)へのSSO遷移確認
