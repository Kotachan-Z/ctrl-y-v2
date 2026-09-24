# Phase 1 検証記録

実施日: 2026-09-24。**全 DoD 合格**。ローカルコミット済み。

環境: macOS arm64 / Bun 1.3.14 / Node 22。

Codex によるスキャフォールド生成後、依頼元セッション（ネットワーク・localhost bind・
`.git` 書き込みが可能な環境）で全項目を再検証した。

| DoD | 実行コマンド                                                                | 結果                                                                                                                                                               |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `bun install`                                                               | 成功: 708 packages installed, `bun.lock` 生成                                                                                                                      |
| 2   | `bun run type-check`（`tsc --noEmit` + `turbo type-check`）                 | 成功: 3 packages (`@ctrl-y/api`, `@ctrl-y/database`, `@ctrl-y/web`) すべて成功                                                                                     |
| 3   | `bun run oxlint` / `bunx oxfmt --check`                                     | 成功: 0 warnings / 0 errors、フォーマット済み                                                                                                                      |
| 4   | `bun run build`（`turbo build`）                                            | 成功: `apps/api` (tsc)、`apps/web` (vite build, dist 出力) ともに成功                                                                                              |
| 5   | `apps/web` dev サーバー起動確認                                             | 成功: `vite --host 127.0.0.1` 起動、`curl /` でタイトル `Ctrl-Y v2` を含む HTML を確認                                                                             |
| 6   | `apps/api` dev サーバー起動確認                                             | 成功: `curl /health` → `{"status":"ok"}`                                                                                                                           |
| 7   | `packages/database`: `generate` → `migration` → `seed` → `verify`（PGLite） | 成功: `users` テーブルのマイグレーション適用・seed・Drizzle 経由の読み取りを確認                                                                                   |
| 8   | `bun run test:e2e`（Playwright, chromium）                                  | 成功: `e2e/smoke.spec.ts` 1 test passed（トップページのタイトル/見出し表示 + `/health` 疎通を検証）                                                                |
| 9   | `.github/workflows/*.yml`, `firebase.json`, `.firebaserc` の内容確認        | 妥当: CI は lint/type-check/build/DBマイグレーション検証 + Playwright の2ジョブ構成。Firebase は Hosting(`apps/web/dist`) + Functions(`apps/api`, nodejs22) を参照 |
| 10  | README.md のセットアップ・開発コマンドの整合性確認                          | 成功: 本構成に合わせて記載済み                                                                                                                                     |

## 環境固有の注意点（スキャフォールド自体の欠陥ではない）

このマシンでは Docker Desktop のプロキシが port 3000 を占有しており（別プロジェクトの
コンテナに起因）、デフォルト設定のまま `bun run test:e2e` を実行すると API の webServer が
port 3000 にバインドできず待機がタイムアウトする。検証時は `API_PORT=3400` を注入した
一時的な Playwright config（未コミット、検証後に削除）で回避した。CI (GitHub Actions) や
他の開発者のマシンではこの衝突は想定されない。本番/開発で port 3000 が恒常的に競合する
場合は `.mise-tasks/dev` や `mise.toml` で既定の `API_PORT` を変更することを検討する。

## Git

Codex 実行環境ではサンドボックス制約により `.git` への書き込みができず、コミットは
未作成のまま報告された。依頼元セッションで `bun install` 以降の全検証を行った上で、
スキャフォールド一式をローカルコミットした。push / PR 作成はレビュー完了後に行う。
