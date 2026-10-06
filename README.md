# Ctrl-Y v2

親子向けタスク報酬管理アプリ「Ctrl-Y（ご褒美ポケット）」の技術スタック刷新版。
元プロジェクト: https://github.com/ctrl-Yc/Ctrl-Y （機能仕様の参照のみ。コード移植なし）

Phase 2b: 親・子供の認証とデータモデルに加え、タスク管理（CRUD・ステータス遷移、PR #2）まで main にマージ済みです。Phase 2cの給与集計も実装済みです。Phase 2dの通知も実装済みです。Phase 2eのPWAも実装済みです。
検証状況と環境制約は [Phase 2a 検証記録](docs/phase-2a-verification.md) を参照してください。

## 構成

```text
apps/web/          React + Vite（TypeScript）
apps/api/          Hono、Bun 開発サーバー、Cloudflare Workers
packages/database/ Drizzle schema / migrations / PGLite / 開発用 seed
e2e/              Playwright ブラウザ・API スモークテスト
.mise-tasks/       setup / dev / check / format
.github/workflows/ CI・CodeQL・手動 Cloudflare デプロイ
.github/dependabot.yml npm / GitHub Actions の週次依存更新
```

Bun workspaces + Turbo でタスクを実行します。oxlint（型情報込み）/ oxfmt と
lefthook を使用し、モノレポ向けの構成を小規模プロジェクト向けに適合しています。
Terraform、Docker、Next.js は使用しません。

### CI

- `ci.yml`: lint・整形・型検査・テスト・ビルド・DB検証・Playwrightを実行。両ジョブで `bun.lock` をキーにBunのダウンロードキャッシュを共有し、frozen installを行います。ジョブの権限は `contents: read` のみです。
- `codeql.yml`: mainへのpush・PRと週次スケジュールでJavaScript/TypeScriptを解析します。解析ジョブにのみ `security-events: write`、`contents: read`、`actions: read` を付与します。
- `dependabot.yml`: npm（ルート・各workspace）とGitHub Actionsの更新PRを毎週作成します。
- `deploy.yml`: mainへのpush、またはActionsの「Cloudflare deploy」から手動実行（workflow_dispatch）。リポジトリSecretsの `CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID` を事前確認し、未設定時は停止します。Bunのfrozen install → Webビルド → WranglerでWorker・静的アセットをデプロイします。権限は `contents: read` のみです。

## セットアップ

前提: mise、Git。リポジトリのルートで実行します。

```sh
mise trust
mise install
bun install
cp apps/api/.env.example apps/api/.env.local
bunx --no-install lefthook install
bunx --no-install playwright install chromium
mise run dev
```

上記の手順でセットアップできます。依存関係のインストール、型検査・lint・整形検査・ビルド、
DB の migration・seed・検証、開発サーバー起動、Playwright E2E は検証済みです。
`bun.lock` を含むスキャフォールドはローカルコミット済みです。
検証の詳細と環境固有の注意点は [検証記録](docs/phase-1-verification.md) を参照してください。
`mise run setup`（frozen install + hooks）で、コミット済みの lockfile に基づく
再現可能なセットアップを行えます。CI と pre-commit もこの lockfile を使用します。

`mise run dev` はリポジトリ直下の **`.pglite/` を毎回削除**し、
migration → seed → Turbo dev の順で起動します。開発データを残す場合は `bun run dev` を使用します。

- Web: http://127.0.0.1:5173 — 親ログイン
- API: http://127.0.0.1:3000/api/health — `{"status":"ok"}`
- Web の `/api/*` は Vite proxy 経由で API に到達します。
- ポート 3000 が使用中なら `API_PORT=3300 bun run dev` で API と proxy を切り替えられます。

## 開発コマンド

| コマンド                                      | 内容                                                 |
| --------------------------------------------- | ---------------------------------------------------- |
| `mise run dev`                                | DB 初期化後に両アプリを起動                          |
| `bun run dev`                                 | DB を保持して両アプリを起動                          |
| `mise run format`                             | oxfmt で整形                                         |
| `bun run oxlint`                              | 型情報を含む lint                                    |
| `bun run oxfmt --check`                       | 整形検査                                             |
| `bun run type-check`                          | ルート設定・E2E・全 workspace の型検査               |
| `bun run build`                               | Web ビルド・Workers bundle の dry-run 検証           |
| `bun run test`                                | Hono の Vitest テスト                                |
| `bun run test:e2e`                            | Vite / Hono を自動起動して Playwright スモークテスト |
| `mise run check`                              | 整形・lint・型検査・単体テスト・ビルド               |
| `bun run --filter @ctrl-y/database generate`  | スキーマ差分の migration 生成                        |
| `bun run --filter @ctrl-y/database migration` | ローカル PGLite に migration 適用                    |
| `bun run --filter @ctrl-y/database seed`      | 開発用レコードを冪等に登録                           |
| `bun run --filter @ctrl-y/database verify`    | seed 済みレコードを Drizzle で確認                   |

E2E は起動済みサーバーを再利用しないため、開発サーバーを停止してから実行してください。
pre-commit は frozen install の dry-run → format → lint --fix → 型検査 → build を順に実行します。

## データベース

ローカルは `.pglite/database`、PostgreSQL dialect、`snake_case`、timestamp prefix の migration を使用。
`parents` / `children` / `tasks` / `payroll` の4テーブルです。
Phase 1 の migration は再生成済みのため、既存の疎通確認DBは `mise run dev` で初期化してください。
seed は `parent@example.test` / `local-password`、子供のあいことばは `ひみつのことば` です（開発専用）。
`PGLITE_PATH` でローカルDBの保存先を差し替えられます。APIとmigrationには同じ絶対パスを渡してください。
本番 DB は Supabase PostgreSQL に Hyperdrive + postgres.js + Drizzle で接続します。資格情報の設定・本番 migration の適用は別途必要です。

## Cloudflare Workers

Worker・CIのbundle検証・手動デプロイworkflowは実装済みです。初回デプロイ前のアカウント固有設定は以下のとおりです。通常の `bun run dev` は Bun + PGLite を使用します。

- ルートの `wrangler.toml`: Web の静的配信・SPA fallback、`/api`・`/api/*` の Worker 優先ルーティング、Hyperdrive binding。
- `apps/api/src/worker.ts`: Hono を直接実行し、env の JWT/VAPID を既存の検証に渡します。アプリと DB 接続はリクエスト単位で生成・通知完了後に終了します。
- `packages/database/src/production.ts`: Hyperdrive + postgres.js + Drizzle の接続ファクトリ。
- `bun run build` はWebビルド完了後にWorkersのdry-runを実行し、CIでも同じbundleを検証します。初回設定後はルートで `bun run build` → `bun run deploy`、またはActionsの「Cloudflare deploy」を手動実行します。Workers Paid を前提とし、bcryptjs cost 12 は維持します。
- デプロイ前に人手で `bunx wrangler login`、`bunx wrangler hyperdrive create ctrl-y-v2 --connection-string=<supabase-connection-string> --caching-disabled` を実行し、設定の仮 ID を置換してください。Cloudflare / Supabase のアカウントと、本番 DB への既存 migration 適用が必要です（この経路は migration を自動適用しません）。
- `bunx wrangler secret put <名前>` で `JWT_SECRET`（32 バイト以上）、`VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT` を登録してください。
- 本番 migration はルートで `PRODUCTION_DATABASE_URL='<Supabase の直接接続文字列>' bun run --filter @ctrl-y/database migration:production` を手動実行します。ローカル CLI から Hyperdrive を経由せず、既存の `packages/database/migrations` を適用します。接続文字列は必須で、未設定・空文字の場合は drizzle-kit がエラー終了します。CI・デプロイでは自動適用しません。
- ローカル Workers 検証は `bun run build` 後に `bun run dev:workers`。ルートの `.dev.vars` に同じ秘密値を設定し、`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` に検証用 PostgreSQL 接続文字列を指定します。PGLite への fallback はありません。

### 認証APIのRate Limiting binding

`wrangler.toml` には `[[ratelimits]]` として `name = "AUTH_RATE_LIMITER"`、
`namespace_id = "1001"`、`simple = { limit = 60, period = 60 }` を設定済みです。
現在のWrangler 4.142.0で対応する専用セクションを使用し、`unsafe.bindings` は不要です。

デプロイ前に、次を確認してください（本プロジェクトはWorkers Paid前提）。

1. 上記のCloudflareアカウント認証・既存binding・Secretの準備を済ませます。
2. `namespace_id` はCloudflareから発行されるIDではなく、自分で選ぶ正の整数の文字列です。
   同一アカウントの他Worker・他環境で `"1001"` を別用途に使っていなければ、そのまま利用できます。
   使用済みでカウンタ共有を意図しない場合は、アカウント内で未使用の値に置き換えてください。
   同じnamespaceとキーは別Workerでもカウンタを共有するため、独立した検証環境にも別の値を選びます。
3. Rate Limiting namespaceの事前作成用Wranglerコマンドや、ダッシュボードでの追加作成操作は不要です。
   設定の確認後は、このbindingのための追加アカウント操作なしで、通常のデプロイ時に有効化されます。
   利用者がルートで `bun run build`（dry-run）を確認し、`bun run deploy` で反映してください。
   dry-runだけでは本番に反映されません。

設定方法・namespaceの意味は[Cloudflare公式ドキュメント](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)を参照してください。

Workerは `POST /api/parents`、`POST /api/parents/login`、`POST /api/children/:childId/login` に対し、
`CF-Connecting-IP` 単位で3ルート合算の60リクエスト/60秒を設定し、超過時はHono・DB接続より前に
429（`Retry-After: 60`）を返します。識別子単位の失敗カウンタとは独立した二段防御です。
ネイティブ制限はPoP単位・結果整合性で、複数PoPをまたぐ厳密な一律上限ではありません。
共有IPの利用者は同じ枠を消費します。通常のBun開発サーバーではこの層を使用せず、
Workerでもbindingまたは `CF-Connecting-IP` がない場合はスキップします。

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
- HS256・用途`reset`・親ロール・専用audience・issuerを検証し、期限は15分。DBの親レコードにSHA-256ハッシュと期限を保存し、更新時に原子的に消費します。再発行はメール送信成功後にDBへ保存し、その時点で古いリンクは無効です。送信失敗時は以前のリンクを維持します。既存のログインJWTは従来の24時間の期限まで有効です。
- レート制限は要求が正規化したメールごと、確認が送信されたトークンのSHA-256ダイジェストごとに各5回/60秒で、成功もカウントします。要求のメール形式不正やJSON解析エラーはカウントしません。確認ではJSON解析後のパスワード・トークン検証エラーもカウントし、トークンが未指定または文字列でない場合は共通の不正入力用枠を使います。Workersでもリクエストをまたいで保持しますが、複数isolate間の共有はありません。異なるトークンを使う大量リクエストを全体で制限するものではありません。
- ローカルは `apps/api/.env.local` の `RESEND_API_KEY` を空にすると、APIコンソールにリンクを出します。実メールは送りません。`WEB_ORIGIN=http://127.0.0.1:5173` を設定します。
- 本番はResendで送信ドメインを検証し、送信権限を持つAPIキーを作成してください。`bunx wrangler secret put RESEND_API_KEY` と `bunx wrangler secret put RESEND_FROM_EMAIL` でキー・送信元（例 `Ctrl-Y <noreply@example.com>`）を設定し、`WEB_ORIGIN` に公開WebのHTTPSオリジンを設定します。同名の値を `.dev.vars` に設定すればWorkersローカル検証にも使えます。本番では未設定でもリンクをログ出力しません。
- [Resend HTTP API](https://resend.com/docs/api-reference/emails/send-email)へ送信します。10秒でタイムアウトし、失敗は秘密値を含めずログに記録します。Workersでは`waitUntil`で配信処理を継続し、ローカルBunでも配信完了を待たずに応答します。永続キューや自動再送はありません。
- デプロイ前に追加migrationを適用してください。ローカルは `bun run --filter @ctrl-y/database migration`、本番は既存の `migration:production` 手順を使います。
