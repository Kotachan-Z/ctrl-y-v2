# Ctrl-Y v2

親子向けタスク報酬管理アプリ「Ctrl-Y（ご褒美ポケット）」の技術スタック刷新版。
元プロジェクト: https://github.com/ctrl-Yc/Ctrl-Y （機能仕様の参照のみ。コード移植なし）

Phase 1 は開発基盤のみ。タスク・報酬・認証などの製品機能は未実装です。

## 構成

```text
apps/web/          React + Vite（TypeScript）
apps/api/          Hono、Bun 開発サーバー、Firebase Functions 第2世代
packages/database/ Drizzle schema / migrations / PGLite / 開発用 seed
e2e/              Playwright ブラウザ・API スモークテスト
.mise-tasks/       setup / dev / check / format
.github/workflows/ lint・型検査・ビルド・DB検証・Playwright
```

Bun workspaces + Turbo でタスクを実行します。oxlint（型情報込み）/ oxfmt と
lefthook を使用し、モノレポ向けの構成を小規模プロジェクト向けに適合しています。
Terraform、Docker、Next.js は使用しません。

## セットアップ

前提: mise、Git。リポジトリのルートで実行します。

```sh
mise trust
mise install
bun install
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

- Web: http://127.0.0.1:5173 — `Ctrl-Y v2 — Coming soon`
- API: http://127.0.0.1:3000/health — `{"status":"ok"}`
- Web の `/health` は Vite proxy 経由で API に到達します。
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
`users` と固定 ID の seed は疎通確認専用で、製品のユーザー・認証モデルではありません。
本番 DB は Supabase PostgreSQL を予定していますが、本 PR では接続・資格情報・本番 migration の適用は実装しません。

## Firebase

- Hosting: `apps/web/dist`。SPA fallback と `/health` → `api` Functions rewrite。
- Functions: `apps/api` → `dist/functions.js`、第2世代 Node.js 22、`asia-northeast1`。
- `server.ts` の Hono アプリを Bun の `entry.ts` と Firebase の `functions.ts` で共有。
- Functions は `@hono/node-server` の `getRequestListener` と `onRequest` で統合し、TypeScript を Node.js ESM にビルド。
- `firebase.json` の predeploy でそれぞれの成果物をビルド。
- `.firebaserc` の `demo-ctrl-y-v2` は仮 ID。実際のプロジェクト ID へ置き換えてからデプロイする前提です。

ランタイムは [Firebase の Node.js ランタイム設定](https://firebase.google.com/docs/functions/manage-functions#set_nodejs_version) に準拠。
この作業では Firebase ログイン・デプロイを行いません。
