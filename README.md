# Ctrl-Y v2

親子向けタスク報酬管理アプリ「Ctrl-Y（ご褒美ポケット）」の技術スタック刷新版。
元プロジェクト: https://github.com/ctrl-Yc/Ctrl-Y （機能仕様の参照のみ。コード移植なし）

Phase 2b: 親・子供の認証とデータモデルに加え、タスク管理（CRUD・ステータス遷移、PR #2）まで main にマージ済みです。Phase 2cの給与集計も実装済みです。通知・PWAは後続フェーズです。
検証状況と環境制約は [Phase 2a 検証記録](docs/phase-2a-verification.md) を参照してください。

## 構成

```text
apps/web/          React + Vite（TypeScript）
apps/api/          Hono、Bun 開発サーバー、Firebase Functions 第2世代
packages/database/ Drizzle schema / migrations / PGLite / 開発用 seed
e2e/              Playwright ブラウザ・API スモークテスト
.mise-tasks/       setup / dev / check / format
.github/workflows/ CI・CodeQL・手動 Firebase デプロイ
.github/dependabot.yml npm / GitHub Actions の週次依存更新
```

Bun workspaces + Turbo でタスクを実行します。oxlint（型情報込み）/ oxfmt と
lefthook を使用し、モノレポ向けの構成を小規模プロジェクト向けに適合しています。
Terraform、Docker、Next.js は使用しません。

### CI

- `ci.yml`: lint・整形・型検査・テスト・ビルド・DB検証・Playwrightを実行。両ジョブで `bun.lock` をキーにBunのダウンロードキャッシュを共有し、frozen installを行います。ジョブの権限は `contents: read` のみです。
- `codeql.yml`: mainへのpush・PRと週次スケジュールでJavaScript/TypeScriptを解析します。解析ジョブにのみ `security-events: write`、`contents: read`、`actions: read` を付与します。
- `dependabot.yml`: npm（ルート・各workspace）とGitHub Actionsの更新PRを毎週作成します。
- `deploy.yml`: Actionsの「Firebase deploy」から手動実行のみ。リポジトリSecretsに `FIREBASE_SERVICE_ACCOUNT`（デプロイ権限を持つサービスアカウントのJSON）と `FIREBASE_PROJECT_ID` を設定してください。未設定時は停止します。Node.js 22・Bunで依存をインストールし、`firebase.json` のpredeployで `bun run --filter @ctrl-y/web build` と `bun run --filter @ctrl-y/api build` を実行してHosting/Functionsをデプロイします。プロジェクトIDは `--project` で指定し、一時的な認証ファイルは終了時に削除します。本番プロジェクト・JWT Secret・本番DB接続の準備を済ませてから実行してください。

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
| `bun run build`                               | Web と Functions のビルド                            |
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
本番 DB は Supabase PostgreSQL を予定していますが、本 PR では接続・資格情報・本番 migration の適用は実装しません。

## Firebase

- Hosting: `apps/web/dist`。SPA fallback と `/api/**` → `api` Functions rewrite。
- Functions: `apps/api/dist` → `functions.js`、第2世代 Node.js 22、`asia-northeast1`。
- `server.ts` の Hono アプリを Bun の `entry.ts` と Firebase の `functions.ts` で共有。
- Functions は `@hono/node-server` の `getRequestListener` と `onRequest` で統合し、BunでNode.js ESMへbundleします。`dist/package.json` はFirebase用の独立した依存宣言で、workspace参照を含みません。
- `firebase.json` の predeploy でそれぞれの成果物をビルド。
- `.firebaserc` の `demo-ctrl-y-v2` は仮 ID。手動デプロイworkflowではSecretsの実際のプロジェクトIDを `--project` で指定して上書きします。

ランタイムは [Firebase の Node.js ランタイム設定](https://firebase.google.com/docs/functions/manage-functions#set_nodejs_version) に準拠。
この作業では Firebase ログイン・デプロイを行いません。

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
  Firebaseでは同名Secretを設定します。秘密値のソース内fallbackはありません。
- 本番DB adapterは未接続です。Functionsの認証APIは接続実装まで利用できません。
  `createApp` にrepositoryを注入する設計で、ローカルPGLiteを本番で誤使用しません。
- タスクの状態enumと所有者制約までを定義しています。状態遷移の操作・逆戻り防止は
  Phase 2bのタスク更新処理で実装済みです。給与のmonthは対象月1日のDATEです。
- Playwrightは `.pglite/e2e` にmigrationを適用し、テスト専用JWT_SECRETで起動します。

## Phase 2c 給与集計

- DONEタスクの件数・報酬合計を、子供ごとに`completedAt`のUTC暦月で再集計します。monthは`YYYY-MM-01`。
- 完了承認・親によるDONE → WAIT_REVIEWへの差し戻し・DONEの報酬編集・削除で更新。同じ月の再集計は冪等で、対象がなくなると0件・0円を保持します。
- `GET /api/payroll`: 親のみ、自分の子供全員の給与。`month`・`childId`で絞り込み可能。
- `GET /api/children/:childId/payroll`: 自分の子供の親、または子供本人のみ。月の昇順で履歴を返します。
- 両APIのレスポンスは`{ payroll: [...] }`。各行は給与テーブルの項目を返します。
