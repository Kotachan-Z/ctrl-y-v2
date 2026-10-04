# Phase 2a 検証記録

2026-09-24、作業ブランチ `feat/phase2-data-model-auth`。
初回検証時の制約と、その後の検証結果を分けて記録します。
Phase 2a本体は `9504817` (`feat: Phase 2a — data model and authentication`) として、
`bun.lock` を含めローカルコミット済みです。

## 既知の制約事項(レート制限、2026-09-25時点でPhase 2aとして確定)

`apps/api/src/rate-limit.ts` の失敗回数ベースのレート制限について、Claude/Codex双方の
独立レビュー(計4ラウンド)を経て以下の残存課題が判明しています。いずれも今回のPhase 2a
では修正せず、既知の制約として記録した上でこの内容のままマージすることを合意済みです
(2026-09-25、ユーザー承認)。

- **5回未満の失敗履歴のエビクションによるバイパス**: 容量上限(10,000件)に達した際、
  まだロックアウトに至っていない(`failures < 5`)エントリはエビクション対象になる。
  攻撃者が大量の別識別子でMapを圧迫する操作を繰り返すことで、対象識別子の失敗回数を
  実質的にリセットし続けられ、60秒ロックアウトに到達させないバイパスが成立しうる
  (レビューにて実行確認済み)。
- **識別子フラッドによる正規ユーザーへのDoS**: 未登録メールアドレスや存在しない
  childId でも失敗エントリを作成できるため、攻撃者が大量の使い捨て識別子でMapを
  容量上限まで満たすと、それ以降の新規識別子(正規ユーザーの初回アクセスを含む)は
  空き待ちで429を返す可能性がある(期限切れ後は自然に解消する一時的な状態)。
- **プロセス間でのカウンタ非共有**: Firebase Functions(第2世代)は複数インスタンスに
  分散しうるため、この状態はインスタンス内のみで有効。インスタンスを跨いだ一貫した
  制限は提供されない。
- 上記2点は「正確性(有効なロックを守る)」と「DoS耐性(攻撃者が量産できる識別子から
  容量を守る)」がトレードオフの関係にあり、インメモリMap単体の設計では両立が困難。
  根本的な解決には、IPアドレス等キーの異なる二段目の流量制御、または外部ストア
  (Redis等のTTL付きキー管理)への移行が必要と考えられる。

**この制約を許容できる理由**: 元アプリ(Ctrl-Y)にはレート制限の仕組みが一切なく、
今回の実装は既に厳密な改善である。また `apps/api/src/functions.ts` の本番DBリポジトリ
アダプタは意図的に未実装(呼び出すと例外を投げる)であり、本番Supabase接続が実装される
までこの認証APIは実際にはデプロイ・攻撃可能な状態にない。本番デプロイに着手する前の
専用フェーズで、上記の二段防御または外部ストアへの移行を検討することとする。

**追記: レート制限強化（2026-10-05、現ワーキングツリーの実装）**

上記は当時の判断の記録です。現在のCloudflare Workers向け実装では、次の対応を追加しています。
本番への反映は利用者によるデプロイ後です。

- **エビクションによるバイパス: 緩和済み**。容量上限時は、処理中でないエントリのうち
  期限切れを優先し、次に失敗回数が少ないものを削除します。同数なら古くから待機している
  ものを選び、複数回の失敗履歴を使い捨て識別子より残しやすくしました。
  安全な候補がなく全てロック中の場合も、最も古い待機エントリを強制削除します。
  全て処理中の場合はMapへの登録が最も古いエントリを削除し、新規キーの追加を拒否しません。
  可用性を優先するため、大量の悪意あるアクセスで他者のロックアウトが早期解除されうる
  トレードオフを許容します。失敗履歴の消失によるバイパス自体を完全に防ぐものではありません。
- **識別子フラッドによる容量不足のDoS: 対応済み**。Mapが満杯であることだけを理由に
  新規識別子へ429を返す経路を解消しました。既存識別子の失敗・同時試行上限や、下記の
  IP制限による429は引き続き発生します。あらゆるDoSや共有IP利用者への影響の解消を意味しません。
  ただし、容量超過時の強制エビクションは処理中（in-flight）のエントリも対象にしうるため、
  全エントリが処理中で埋まった極端な状況では、同一識別子への同時試行上限（5件）が
  例外的に解除されうる点に注意が必要です。これは今回追加した強制エビクション戦略の
  直接の帰結であり、既存の可用性を優先するトレードオフという設計判断の範囲内です。
- **インスタンス間非共有: 緩和済み**。`worker.ts` の `AUTH_RATE_LIMITER`
  （`wrangler.toml` の `[[ratelimits]]`）により、認証系の3エンドポイント
  （`POST /api/parents`、`POST /api/parents/login`、`POST /api/children/:childId/login`）
  に独立したIPベースの防御層を追加しました。`CF-Connecting-IP` をキーに全対象ルート合算で
  60秒あたり60リクエストを設定し、超過時はHono・DB接続より前に429を返します。
  Cloudflareのエッジ側でisolateをまたいで利用する制限ですが、共有範囲は拠点（PoP）単位で、
  結果整合性です。**複数PoPをまたぐ厳密な一律の上限は保証しません**。
  識別子単位の失敗カウンタはWorkerの同一isolate内でリクエストをまたいで保持しますが、
  isolate間では共有しません。Bun開発サーバーではネイティブbindingを使わず、Workerでも
  bindingまたは送信元IPヘッダがない場合はIP制限をスキップします。
  共有範囲の根拠: [Cloudflare Rate Limiting公式仕様](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)。

## 実装

- `/api` ルート、Vite proxy、Hosting rewrite、Playwright health URLを統一。
- parents / children / tasks / payroll、新migration、PGLite factory、seed / verify。
- bcryptjs、Hono JWT、親登録・ログイン、セットアップ、子供一覧・追加・ログイン。
- 初回セットアップは親行をロックするトランザクションで実行。
- JWT共通認証・親限定認可・familyIdヘルパー・画面ガード向けsession API。
- React Routerの各画面、APIクライアント、親子別localStorage、コピー・ログアウト。
- APIテスト、DB制約テスト、JWTテスト、認証フローE2E。
- Firebase用bundleと独立したdist/package.json生成。workspace依存をデプロイ先に持ち込まない。

## 初回検証後の結果（オーケストレーター側セッション）

以下は依頼者から引き継いだ検証済みの記録です。

- `bun install`、type-check、oxlint、oxfmt、build: 全て成功。
- Drizzle + PGLite の generate / migration / seed / verify: 全て成功。
- API実起動とcurlによる親登録・ログイン・setup・子供ログイン: 成功。
- Vitest単体テスト: 全件成功。Playwright E2E: 2件成功。
- `bun.lock` 更新を含めローカルコミット済み（上記コミット）。

## 独立レビュー5件への修正と再検証（2026-09-24）

- 登録は正規化メール、親ログインは正規化メール、子供ログインは小文字化childIdをキーに、別々の失敗カウンタを保持。
  最初の失敗から60秒以内に5回失敗すると、5回目から60秒ロックアウトし、6回目以降は429。
  ロック前の成功でリセット、時間経過でもリセット。認証失敗401・登録重複409を数え、入力不正400やサーバーエラー500は数えない。
  短い共有あいことばへの連続試行を抑えつつ、通常の入力ミスから復帰しやすい閾値とした。
  Functionsではアプリを遅延初期化して再利用する。Mapはインスタンス内のみで、再起動・複数インスタンス間の制限は保証しない。
  既に処理中のリクエストは中断しない。外部ストアへの移行は今回の範囲外。
- 名前・メール・パスワード・あいことばのNUL文字を400で拒否。
- `firebase-admin` をAPIとdistの直接依存から削除。`firebase-functions` の必須peer依存なので、lockfileと間接インストールには残る。
  `bun.lock` も更新し、Bunによる依存配置の再計算を反映。
- 生成済み `apps/api/dist/package.json` にscriptsがないことを確認し、元の `gcp-build` を削除。
  Functionsのignoreは `node_modules`、`.git`、Firebaseのデバッグログに整理。

| 検証                                                                                                                                     | 今回の結果                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun --bun oxfmt --check`                                                                                                                | 成功                                                                                                                                                                                                   |
| `bun --bun oxlint`                                                                                                                       | 成功、警告・エラー0                                                                                                                                                                                    |
| `bun run type-check`                                                                                                                     | 成功                                                                                                                                                                                                   |
| `bun run build`                                                                                                                          | 成功。distにbuildスクリプト・firebase-admin直接依存がないことも確認                                                                                                                                    |
| `bun run --filter @ctrl-y/api test`                                                                                                      | 成功、5ファイル・20テスト。3エンドポイントの429、識別子の分離、ロック中の正しい認証の拒否、60秒境界、成功リセット、未ロックの時間窓失効、NUL拒否を含む                                                 |
| `bun run --filter @ctrl-y/database generate`                                                                                             | 成功、スキーマ差分なし                                                                                                                                                                                 |
| `bun run --filter @ctrl-y/database migration` / `seed` / `verify`                                                                        | 全て成功。`PGLITE_PATH=/private/tmp/ctrl-y-review-20260924` を使用                                                                                                                                     |
| API実起動 + curl                                                                                                                         | 起動失敗（Bunはlisten時にEADDRINUSE）。ポート自動割当のNode listenでもEPERMを確認し、サンドボックス制約と判明。curlも接続失敗。実通信による認証フロー・429は未確認。VitestのHonoリクエストでは確認済み |
| `bun run test:e2e`                                                                                                                       | 再実行したがサーバー起動で失敗。`DEBUG=pw:webserver` でViteのlisten EPERMとlocalhost接続EPERMを確認。今回のE2E本体は未実行                                                                             |
| `bun install`                                                                                                                            | temp/cache書込拒否。許可されたtmp/cacheに変更するとネットワーク拒否。既存のインストール済み依存で上記検証を実施                                                                                        |
| `TMPDIR=/private/tmp BUN_INSTALL_CACHE_DIR=/private/tmp/ctrl-y-bun-cache bun install --frozen-lockfile --lockfile-only --ignore-scripts` | 成功。lockfileの検査・保存のみで、依存の新規取得成功を意味しない                                                                                                                                       |

## オーケストレーター側セッションでの追加検証（2026-09-24、修正後）

上記の5件の修正について、サンドボックス制約のないオーケストレーター側セッションで実機検証した。

- `bun install`: 変更なし（`Checked 364 installs across 514 packages (no changes)`）。
- `bun --bun oxfmt --check` / `bun --bun oxlint` / `bun run type-check` / `bun run build`: 全て成功。
- `apps/api/dist/package.json` を実際に確認し、`firebase-admin` が依存に含まれないことを確認。
- `bun run --filter @ctrl-y/api test`: 5ファイル・20テスト全件成功（rate-limit.spec.ts 6件、NUL拒否テスト含む）。
- DB: `generate` / `migration` / `seed` / `verify` 全て成功。
- API実起動 + curl:
  - 誤ったパスワードで6回連続ログイン試行 → 1〜5回目は401、6回目で429を確認。
  - NUL文字を含むメールアドレスでの登録試行 → 400を確認。
  - 別のメールアドレスでの新規登録 → レート制限の影響を受けず201を確認。
- `bun run test:e2e`: 2件成功（smoke, auth）。

Codexによる修正実装は正しく機能することを実通信で確認済み。

## 初回検証時のDoD結果（履歴）

この時点では未コミットで、環境制約によりDoD未達成と判定していた。
以下は当時の結果であり、現在の本体の検証・コミット状態ではない。

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

## 初回検証時に記録した残作業（履歴）

当時はネットワーク・localhost bindが許可された環境での依存取得と全検証の再実行が必要だった。
`bun.lock` も未更新だったが、その後オーケストレーター側で更新・検証・コミット済み。
以下のコマンド一覧は再検証手順として残す。

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
