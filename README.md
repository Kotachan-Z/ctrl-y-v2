# Ctrl-Y v2

親子向けタスク報酬管理アプリ「Ctrl-Y（ご褒美ポケット）」の技術スタック刷新版です。
親がタスクと報酬を設定し、子供が完了を報告、親が承認すると月ごとの「お給料」に集計されます。

元プロジェクト: [ctrl-Yc/Ctrl-Y](https://github.com/ctrl-Yc/Ctrl-Y)（機能仕様の参照のみ。コードは移植していません）

## 主な機能

- **アカウント**: 親はメール + パスワード、子供は親が発行するログインURL + あいことば
- **タスク管理**: 作成・編集・削除、`TODO → IN_PROGRESS → WAIT_REVIEW → DONE` の状態遷移（親は DONE を WAIT_REVIEW に差し戻し可）
- **給与集計**: 承認済みタスクの件数・報酬を子供ごと・月ごとに自動集計
- **通知**: 子供の完了報告を親に Web Push で通知（失敗時は本番環境のみ自動再送）
- **PWA**: ホーム画面に追加でき、閲覧済みの画面はオフラインでも表示。子供の完了報告はオフライン時に保存して後で送信
- **パスワードリセット**: メールのリンクから再設定（Resend で送信）

## 技術スタック

| 領域         | 使用技術                                                                    |
| ------------ | --------------------------------------------------------------------------- |
| 言語         | TypeScript                                                                  |
| Web          | React, Vite, React Router, Tailwind CSS                                     |
| API          | Hono（ローカルは Bun、本番は Cloudflare Workers）、bcryptjs、JWT            |
| DB           | Drizzle ORM / ローカル: PGLite / 本番: Supabase（Hyperdrive + postgres.js） |
| 外部サービス | Web Push（@block65/webcrypto-web-push）、Resend（メール）                   |
| テスト       | Vitest, Playwright                                                          |
| ツール       | Bun workspaces, Turborepo, mise, oxlint, oxfmt, lefthook                    |
| CI/CD        | GitHub Actions（CI・CodeQL・Cloudflare デプロイ）, Dependabot               |

```text
apps/web/          フロントエンド（React + Vite）
apps/api/          API（Hono）
packages/database/ Drizzle のスキーマ・migration・開発用 seed
e2e/               Playwright の E2E テスト
docs/              詳細仕様・デプロイ手順・検証記録
.mise-tasks/       setup / dev / check / format
.github/           CI・CodeQL・デプロイ・Dependabot
```

## セットアップ

前提: [mise](https://mise.jdx.dev/) と Git。リポジトリのルートで実行します。

```sh
mise trust && mise install
bun install
cp apps/api/.env.example apps/api/.env.local
bunx --no-install lefthook install
bunx --no-install playwright install chromium
```

`bun install` と `lefthook install` は `mise run setup` でまとめて実行することもできます（lockfile 固定でインストール）。

`apps/api/.env.local` の `VAPID_*` は置き換えが必要です（`npx web-push generate-vapid-keys` で生成）。

```sh
mise run dev
```

| URL                              | 内容                     |
| -------------------------------- | ------------------------ |
| http://127.0.0.1:5173            | Web（親ログイン）        |
| http://127.0.0.1:3000/api/health | API（`{"status":"ok"}`） |

- 開発用ログイン: `parent@example.test` / `local-password`、子供のあいことば `ひみつのことば`
- `mise run dev` は起動のたびにローカル DB（`.pglite/`）を作り直します。データを残すなら `bun run dev`
- Web の `/api/*` は Vite の proxy 経由で API に届きます
- ポート 3000 が使用中なら `API_PORT=3300 bun run dev`

## よく使うコマンド

| コマンド           | 内容                                       |
| ------------------ | ------------------------------------------ |
| `mise run dev`     | DB を初期化して Web と API を起動          |
| `bun run dev`      | DB を残したまま起動                        |
| `mise run check`   | 整形・lint・型検査・単体テスト・ビルド     |
| `mise run format`  | コード整形                                 |
| `bun run test`     | API の単体テスト（Vitest）                 |
| `bun run test:e2e` | E2E テスト（開発サーバーを止めてから実行） |
| `bun run build`    | Web ビルドと Workers バンドルの検証        |

コミット時は lefthook が lockfile 検証 → 整形 → lint → 型検査 → ビルドを自動で実行します。
DB 関連は `bun run --filter @ctrl-y/database <generate | migration | seed | verify>` で実行します。

## ドキュメント

- [機能仕様](docs/features.md) — 認証・給与集計・通知・PWA・パスワードリセットの詳細
- [データベース・デプロイ](docs/deployment.md) — DB 構成、Cloudflare Workers へのデプロイ、Secret 設定、CI
- 検証記録: [Phase 1](docs/phase-1-verification.md) / [Phase 2a](docs/phase-2a-verification.md)
