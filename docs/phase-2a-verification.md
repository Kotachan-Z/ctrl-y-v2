# Phase 2a 検証記録

2026-09-24、作業ブランチ `feat/phase2-data-model-auth`。
実装変更は作業ツリーに保存。commit・push・Firebaseデプロイは行っていません。
**環境制約によりDoD未達成。マージ可能な検証済み状態ではありません。**

## 実装

- `/api` ルート、Vite proxy、Hosting rewrite、Playwright health URLを統一。
- parents / children / tasks / payroll、新migration、PGLite factory、seed / verify。
- bcryptjs、Hono JWT、親登録・ログイン、セットアップ、子供一覧・追加・ログイン。
- 初回セットアップは親行をロックするトランザクションで実行。
- JWT共通認証・親限定認可・familyIdヘルパー・画面ガード向けsession API。
- React Routerの各画面、APIクライアント、親子別localStorage、コピー・ログアウト。
- APIテスト、DB制約テスト、JWTテスト、認証フローE2E。
- Firebase用bundleと独立したdist/package.json生成。workspace依存をデプロイ先に持ち込まない。

## DoD結果

| 項目 | 結果         | 実行結果                                                                                                                                                                                                                                                           |
| ---- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | 未達成       | `bun install` はtemp/cache書込拒否。書込先を許可ディレクトリに変えると依存取得が `ConnectionRefused` / `FailedToOpenSocket`。`type-check`・`oxlint`・`build` はbcryptjs / react-router-domの未取得で失敗。`bun --bun oxfmt --check` と `git diff --check` は成功。 |
| 2    | 一部成功     | `generate` は4テーブルで成功、独立したPGLiteへの `migration` も成功。`seed` / `verify` はbcryptjs未取得で開始できず。                                                                                                                                              |
| 3    | 一部成功     | Vitest全体: 2 suites成功・4 tests成功、auth / healthの2 suitesはbcryptjs未取得でロード失敗。                                                                                                                                                                       |
| 4    | 未検証       | API起動は依存不足で停止。curlによる親登録は接続失敗。後続のログイン→setup→子供ログインは未実行。                                                                                                                                                                   |
| 5    | 未検証       | Web dev起動が `listen EPERM 127.0.0.1:5173`。`bun run test:e2e` もwebServer起動失敗。ブラウザでの表示・操作、既存healthスモークの成功は未確認。                                                                                                                    |
| 6    | 静的検証成功 | JSON parse、rewrite順序、リージョン、function export名、source/build出力・main・proxy・health URLの整合をassertで確認。新しいビルド成果物は依存不足で未確認。                                                                                                      |

DB検証用パス: `/private/tmp/ctrl-y-phase2a-verification`。
Phase 1の開発DBは削除していません。
既存インストール済みのDrizzleとworkspace DBへのローカルnode_modulesリンクを整え、
依存取得不要なDB・JWTテストだけは実行できました。bcryptjsやReact Routerの代用品は使用していません。

成功した部分テスト:

```sh
bun run --filter @ctrl-y/api test -- test/database.spec.ts test/tokens.spec.ts
```

検証内容: 親重複、子供の家族絞り込み、セットアップ競合、失敗時のkeywordロールバック、
タスクの複合外部キー、給与月ユニーク・金額制約、親子JWT、親限定認可、
署名改ざん・異なる署名キー・期限切れ・リセット用途・不正ロール・家族不整合の拒否。

## 残作業

ネットワーク・localhost bindが許可された環境で依存を取得し、全検証を再実行する必要があります。
**bun.lockは更新できていません。現在のpackage.jsonとは不一致なのでCIのfrozen installも未達成です。**

```sh
bun install
cp apps/api/.env.example apps/api/.env.local # 既存設定があれば上書きしない
bun run type-check
bun run oxlint
bun --bun oxfmt --check
bun run build
bun run --filter @ctrl-y/database generate
bun run --filter @ctrl-y/database migration
bun run --filter @ctrl-y/database seed
bun run --filter @ctrl-y/database verify
bun run --filter @ctrl-y/api test
bun run test:e2e
```

Phase 1のDBが残る場合は、開発データを保持するか判断のうえ初期化するか、
`PGLITE_PATH` に新しい絶対パスを指定してください。APIのcurlフローも別途必要です。

## 既定値とスコープ

- パスワード8文字以上、共有あいことば4文字以上。どちらもUnicodeコードポイント数、UTF-8で72バイト以内（bcryptの切り捨て防止）。空白のみは拒否。
- 名前はtrim後1〜50コードポイント。メールはtrim・小文字化、簡易形式検証、254文字以内。
- bcrypt cost 12。あいことばもハッシュ保存し、API応答には返さない。
- JWTは24時間。HS256固定、access用途・issuer・audience・iat/exp・ロール・アカウント存在を検証。
- パスワードリセットAPI、refresh token、タスク操作、給与集計、通知、PWAは未実装。
- 金額は非負整数。給与月は月初DATE。タスクの一方向の遷移操作はPhase 2bの範囲。
- 本番Supabase adapterはスコープ外。Functionsの認証APIはadapter接続まで利用不可。
- JWT仕様の参照: [Hono JWT helper](https://hono.dev/docs/helpers/jwt)。DB制約の参照: [Drizzle constraints](https://orm.drizzle.team/docs/indexes-constraints)。
