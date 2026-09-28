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
- `deploy.yml`: Actionsの「Cloudflare deploy」から手動実行のみ（workflow_dispatch）。リポジトリSecretsの `CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID` を事前確認し、未設定時は停止します。Bunのfrozen install → Webビルド → WranglerでWorker・静的アセットをデプロイします。権限は `contents: read` のみです。

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
- ローカル Workers 検証は `bun run build` 後に `bun run dev:workers`。ルートの `.dev.vars` に同じ秘密値を設定し、`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` に検証用 PostgreSQL 接続文字列を指定します。PGLite への fallback はありません。

## Phase 2a 認証

- 親: `/` ログイン、`/signup` 登録、`/setup` 最初の子供＋あいことば設定。
- 親の `/children` でログインURLの表示・コピー、2人目以降の追加。
- 子供: `/child/login/:childId`、ログイン後は `/child/top/:childId`。親は `/top`。
- `POST /api/parents`, `POST /api/parents/login`, `POST /api/setup`,
  `POST /api/children`, `GET /api/children`, `POST /api/children/:childId/login`。
  `GET /api/session` は画面ガード用のJWT・アカウント存在確認です。
- 親・子供のトークンはlocalStorageの別キーに保存。ログアウトも該当ロールだけ削除。
- JWTはHS256、24時間、用途`access`・issuer・audience・ロールを検証。
  リセット用トークンは通常認証で拒否します。パスワードリセット機能自体は今回未実装。
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
- 送信はレスポンスを待たせないbest-effort。404/410の無効な購読は自動削除し、その他の失敗はログのみ。永続キュー・再送保証はありません。
- `VAPID_PUBLIC_KEY`・`VAPID_PRIVATE_KEY`・`VAPID_SUBJECT`（`mailto:`または`https:`の連絡先URI）が必須。不足・形式不正はアプリ初期化時にエラーになります。
  `npx web-push generate-vapid-keys`で鍵を生成し、`apps/api/.env.local`に設定してください。`.env.example`の値は置換必須のプレースホルダーです。Workersでは同名Secretを設定します。
- 購読UI・PWA・service workerによる表示はPhase 2eで実装済みです。Workersでは `waitUntil` で応答後の通知処理を継続します。確実な配信には今後永続キューが必要です。

## Phase 2e PWA

- 手書きのmanifest・SVGアイコン（any / maskable）でホーム画面への追加に対応。テーマ色・iOS向け表示名も設定しています。
- `/sw.js`を登録し、更新時は即時有効化して旧バージョンのキャッシュを削除します。
- ページHTMLはnetwork-first、ビルド済み静的アセットはcache-first。訪問・読み込み済みの画面をオフラインでも開けます。キャッシュは静的コンテンツのみで、`/api/`は一切介入・保存しません。オフラインでタスク・給与データの取得や更新はできません。
- 親の`/top`で通知を有効化・解除できます。許可後にVAPID公開鍵で購読しAPIへ保存、解除時はブラウザとAPI双方の購読を解除します。未対応・許可拒否は画面に表示します。
- pushのタイトル・本文を通知表示し、クリックで既存ウィンドウを開くか`/`へ移動します。HTTPS（ローカルはlocalhost）が必要です。iOSの通知はホーム画面に追加した対応環境で利用します。
- Playwrightでmanifest・service worker登録・親トップの通知操作を検証します。購読処理はブラウザAPIをモックし、外部pushサービスには接続しません。
