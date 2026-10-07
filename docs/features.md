# 機能仕様

README から移した各機能の詳細仕様です。

## Phase 2a 認証

- 親: `/` ログイン、`/signup` 登録、`/setup` 最初の子供＋あいことば設定。
- 親の `/children` でログインURLの表示・コピー、2人目以降の追加。
- 子供: `/child/login/:childId`、ログイン後は `/child/top/:childId`。親は `/top`。
- `POST /api/parents`, `POST /api/parents/login`, `POST /api/setup`,
  `POST /api/children`, `GET /api/children`, `POST /api/children/:childId/login`。
  `GET /api/session` は画面ガード用のJWT・アカウント存在確認です。
- access tokenとrefresh tokenは親・子供それぞれlocalStorageの別キーに保存。
  401時は該当ロールのrefreshを1回行い、成功時のみ元のリクエストを1回再試行します。
  同時refreshをまとめ、Web Locks対応ブラウザではタブ間も直列化します。
- ログイン・登録のレスポンスは`token`に加え`refreshToken`を返します。
  `POST /api/auth/refresh`は`{ refreshToken }`を受け取り、新しい両トークンを返します（Authorization不要）。
  refresh tokenは256ビットのランダム値・30日有効で、DBにはSHA-256ハッシュのみ保存。
  毎回ローテーションし、失効済みtokenの再利用は同じ系譜を全失効して401にします。
  系譜のルート行をDBでロックし、並行更新にも対応します。独立したログインの系譜は影響しません。
- `POST /api/auth/logout`は`{ refreshToken }`を冪等に失効し、Webは成功後に該当ロールの両tokenを削除。
  通信失敗時は再試行できるよう保持します。発行済みaccess tokenは有効期限まで有効です。
- refreshの失敗はtokenダイジェスト別に5回/60秒で制限します。既存の制限と同様、Workers isolate単位です。
- JWTはHS256、1時間、用途`access`・issuer・audience・ロールを検証。
  24時間から1時間への短縮に伴い、デプロイ後は全利用者の再ログインが必要です。
  リセット用トークンは通常認証で拒否します。
- パスワード・共有あいことばはbcryptjs（cost 12）で保存。
  パスワード8文字以上、あいことば4文字以上、いずれもUTF-8で72バイト以内。
  名前は前後の空白を除いて1〜50 Unicodeコードポイント、メールは前後空白除去・小文字化・254文字以内。
- `JWT_SECRET` は32バイト以上必須。ローカルは `apps/api/.env.local`、
  Workersでは同名Secretを設定します。秘密値のソース内fallbackはありません。
- `createApp` にrepositoryを注入し、WorkersはHyperdrive経由の本番DB、ローカルはPGLiteを使用します。
- タスクの状態enumと所有者制約までを定義しています。状態遷移の操作・逆戻り防止は
  Phase 2bのタスク更新処理で実装済みです。給与のmonthは対象月1日のDATEです。
- Playwrightは `.pglite/e2e` にmigrationを適用し、テスト専用JWT_SECRETで起動します。

## Phase 2c 給与集計

- タスクの報酬は0〜1,000,000円の整数です。APIとDBのCHECK制約で範囲を検証します。

- DONEタスクの件数・報酬合計を、子供ごとに`completedAt`のUTC暦月で再集計します。monthは`YYYY-MM-01`。
- 完了承認・親によるDONE → WAIT_REVIEWへの差し戻し・DONEの報酬編集・削除で更新。同じ月の再集計は冪等で、対象がなくなると0件・0円を保持します。
- `GET /api/payroll`: 親のみ、自分の子供全員の給与。`month`・`childId`で絞り込み可能。
- `GET /api/children/:childId/payroll`: 自分の子供の親、または子供本人のみ。月の昇順で履歴を返します。
- 両APIのレスポンスは`{ payroll: [...] }`。各行は給与テーブルの項目を返します。

## Phase 2d 通知

- `GET /api/push/public-key`: 認証不要、`{ publicKey }`を返します。
- `PUT /api/parents/push-subscription`: 親のみ、ブラウザの`{ endpoint, keys: { p256dh, auth } }`を保存・上書きします（親ごとに1件）。
- `DELETE /api/parents/push-subscription`: 親のみ、自分の購読を解除します。
- 子供のIN_PROGRESS → WAIT_REVIEWへの完了報告で親へ通知。親の差し戻しでは送信しません。
- 送信はレスポンスを待たせないbest-effort。404/410の無効な購読は従来どおり更新前の購読と一致する場合のみ削除します。一時的な失敗（ネットワーク・5秒タイムアウト・408・429・5xx）のみDBの `push_retry_queue` に保存します。その他のHTTPエラーや暗号化失敗は再送しません。
- `VAPID_PUBLIC_KEY`・`VAPID_PRIVATE_KEY`・`VAPID_SUBJECT`（`mailto:`または`https:`の連絡先URI）が必須。不足・形式不正はアプリ初期化時にエラーになります。
  `npx web-push generate-vapid-keys`で鍵を生成し、`apps/api/.env.local`に設定してください。`.env.example`の値は置換必須のプレースホルダーです。Workersでは同名Secretを設定します。
- 購読UI・PWA・service workerによる表示はPhase 2eで実装済みです。Workersでは `waitUntil` で応答後の通知処理を継続します。再送は本番WorkersのCron Triggerで5分おきに最大25件処理します。初回送信とは別に最大5回、1分→5分→15分→1時間→6時間の間隔で再送予約し、期限後のCronで送信します。成功・購読なし・恒久的失敗・上限到達で行を削除します。毎回最新の購読を参照し、キューにはendpoint・鍵や例外本文を保存しません。
- Cronの重複実行は行ロックと10分のリースで抑制し、停止した処理はリース満了後に回収します。送信成功後のDB障害などでは重複通知があり得ます。初回のキュー保存自体が失敗した場合も配信保証はありません。
- ローカルBun開発サーバー（`apps/api/src/entry.ts`）でもキューへ追加されますが、自動処理はありません。自動再送は本番Workersのみ対応です。本番デプロイ前に `bun run --filter @ctrl-y/database migration:production` でキューテーブルを適用してください。

## Phase 2e PWA

- 手書きのmanifest・SVGアイコン（any / maskable）でホーム画面への追加に対応。テーマ色・iOS向け表示名も設定しています。
- `/sw.js`を登録し、更新時は即時有効化して旧バージョンのキャッシュを削除します。
- ページHTMLはnetwork-first、ビルド済み静的アセットはcache-first。訪問・読み込み済みの画面をオフラインでも開けます。認証済みGETの `/api/tasks`、`/api/tasks/:taskId`、`/api/payroll`、`/api/children/:childId/payroll`、`/api/children`、`/api/settings/payroll`、`/api/session` はnetwork-firstで保存し、ネットワークエラー時のみ、同じトークン・URLで直近に取得成功したデータを閲覧できます。未取得のデータは表示できません。キャッシュは認証ヘッダのSHA-256ハッシュで分離し、オフライン表示の注記を出します。
- 子供の「できた!」による完了報告（`PATCH /api/tasks/:taskId/status`、`IN_PROGRESS → WAIT_REVIEW`）のみ、ネットワークエラー時にlocalStorageへ保存し、「送信待ち」と件数を表示します。ページの `online` イベント、タブが表示状態に戻った時、「一覧を更新」、次回アプリ起動時に、操作時と同じ認証トークンで順次再送し、成功後はタスク一覧を更新します。HTTPエラーは再送せず削除して失敗を通知し、ネットワークエラーは次回の再送契機まで保持します。ログアウト時はそのトークンの未送信操作を破棄し、別トークンの操作は送信しません。旧版で保存された完了報告以外の操作は再送時に破棄します。iOS対応のためBackground Sync APIには依存せず、アプリを閉じたままでは再送しません。ブラウザの保存データを削除するとキャッシュ・未送信操作も失われます。
- 子供の「はじめる」、親の承認・差し戻し、タスクの新規作成・編集・削除、給与設定変更など、子供の完了報告以外の書き込みは引き続きオフライン非対応です。
- 親の`/settings/notifications`で通知を有効化・解除できます。許可後にVAPID公開鍵で購読しAPIへ保存、解除時はブラウザとAPI双方の購読を解除します。未対応・許可拒否は画面に表示します。
- pushのタイトル・本文を通知表示し、クリックで既存ウィンドウを開くか`/`へ移動します。HTTPS（ローカルはlocalhost）が必要です。iOSの通知はホーム画面に追加した対応環境で利用します。
- Playwrightでmanifest・service worker登録・通知設定ページの操作を検証します。購読処理はブラウザAPIをモックし、外部pushサービスには接続しません。

## 親のパスワードリセット

- ログイン画面の「パスワードを忘れた場合」→ `/forgot-password` から要求し、メールの `/reset-password/:token` で変更します。
- `POST /api/parents/password-reset/request` は `{ email }`、`confirm` は `{ token, password }` を受け取ります。有効なメール形式であれば登録の有無・送信失敗にかかわらず同じ200応答です。
- HS256・用途`reset`・親ロール・専用audience・issuerを検証し、期限は15分。DBの親レコードにSHA-256ハッシュと期限を保存し、更新時に原子的に消費します。再発行はメール送信成功後にDBへ保存し、その時点で古いリンクは無効です。送信失敗時は以前のリンクを維持します。既存のログインJWT（access token）は有効期限（1時間）まで有効です。
- レート制限は要求が正規化したメールごと、確認が送信されたトークンのSHA-256ダイジェストごとに各5回/60秒で、成功もカウントします。要求のメール形式不正やJSON解析エラーはカウントしません。確認ではJSON解析後のパスワード・トークン検証エラーもカウントし、トークンが未指定または文字列でない場合は共通の不正入力用枠を使います。Workersでもリクエストをまたいで保持しますが、複数isolate間の共有はありません。異なるトークンを使う大量リクエストを全体で制限するものではありません。
- ローカルは `apps/api/.env.local` の `RESEND_API_KEY` を空にすると、APIコンソールにリンクを出します。実メールは送りません。`WEB_ORIGIN=http://127.0.0.1:5173` を設定します。
- 本番はResendで送信ドメインを検証し、送信権限を持つAPIキーを作成してください。`bunx wrangler secret put RESEND_API_KEY` と `bunx wrangler secret put RESEND_FROM_EMAIL` でキー・送信元（例 `Ctrl-Y <noreply@example.com>`）を設定し、`WEB_ORIGIN` に公開WebのHTTPSオリジンを設定します。同名の値を `.dev.vars` に設定すればWorkersローカル検証にも使えます。本番では未設定でもリンクをログ出力しません。
- [Resend HTTP API](https://resend.com/docs/api-reference/emails/send-email)へ送信します。10秒でタイムアウトし、失敗は秘密値を含めずログに記録します。Workersでは`waitUntil`で配信処理を継続し、ローカルBunでも配信完了を待たずに応答します。永続キューや自動再送はありません。
- デプロイ前に追加migrationを適用してください。ローカルは `bun run --filter @ctrl-y/database migration`、本番は既存の `migration:production` 手順を使います。
