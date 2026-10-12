# データベース・デプロイ

README から移したデータベースと Cloudflare Workers デプロイの詳細です。

## データベース

ローカルは `.pglite/database`、PostgreSQL dialect、`snake_case`、timestamp prefix の migration を使用。
`parents` / `children` / `tasks` / `payroll` / `push_retry_queue` / `refresh_tokens` の6テーブルです。
Phase 1 の migration は再生成済みのため、既存の疎通確認DBは `mise run dev` で初期化してください。
seed は `parent@example.test` / `local-password`、子供のあいことばは `ひみつのことば` です（開発専用）。
`PGLITE_PATH` でローカルDBの保存先を差し替えられます。APIとmigrationには同じ絶対パスを渡してください。
本番 DB は Supabase PostgreSQL に Hyperdrive + postgres.js + Drizzle で接続します。資格情報の設定は別途必要です。本番 migration はデプロイworkflowで自動適用・検証します。

## Cloudflare Workers

Worker・CIのbundle検証・デプロイworkflow（mainへのpushで自動実行、手動実行も可）は実装済みです。初回デプロイ前のアカウント固有設定は以下のとおりです。通常の `bun run dev` は Bun + PGLite を使用します。

- ルートの `wrangler.toml`: Web の静的配信・SPA fallback、`/api`・`/api/*` の Worker 優先ルーティング、Hyperdrive binding。
- `apps/api/src/worker.ts`: Hono を直接実行し、env の JWT/VAPID を既存の検証に渡します。アプリと DB 接続はリクエスト単位で生成・通知完了後に終了します。
- `packages/database/src/production.ts`: Hyperdrive + postgres.js + Drizzle の接続ファクトリ。
- `bun run build` はWebビルド完了後にWorkersのdry-runを実行し、CIでも同じbundleを検証します。初回設定後はルートで `bun run build` → `bun run deploy`、またはmainへのpush・Actionsの「Cloudflare deploy」の手動実行でデプロイします。Workers Paid を前提とし、bcryptjs cost 12 は維持します。
- デプロイ前に人手で `bunx wrangler login`、`bunx wrangler hyperdrive create ctrl-y-v2 --connection-string=<supabase-connection-string> --caching-disabled` を実行し、設定の仮 ID を置換してください。Cloudflare / Supabase のアカウントと接続情報の設定が必要です。本番 DB の migration はデプロイworkflowが自動適用します。
- `bunx wrangler secret put <名前>` で `JWT_SECRET`（32 バイト以上）、`VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT` を登録してください。
- 本番 migration はデプロイworkflowがWebビルド → 生成忘れ検査 → `preflight:production`（履歴整合性・適用予定SQLの破壊的DDL検査）の成功後に自動適用し、`verify:production` で全SQLのSHA-256が本番の `drizzle.__drizzle_migrations` に記録されていることを検証してからWorkerをデプロイします。GitHub Actions の `PRODUCTION_DATABASE_URL` secret には、Supabase ダッシュボードからコピーした **Session pooler 接続文字列（ポート5432）** を設定してください。ホストの接頭辞はプロジェクトの世代によって異なります。直接接続ホスト `db.PROJECT_REF.supabase.co` は IPv6 のみのため、IPv4 の GitHub Actions ランナーから到達できません。Transaction pooler（6543）は使用しません。migrator は全migrationを単一トランザクションで実行するため、Transaction poolerでは失敗する可能性があります。手動・ローカルで適用する場合も `PRODUCTION_DATABASE_URL` を設定し、生成忘れがないことを確認したうえで、ルートで `bun run --filter @ctrl-y/database preflight:production` → `bun run --filter @ctrl-y/database migration:production` → `bun run --filter @ctrl-y/database verify:production` を実行してください。ローカルからの直接接続もネットワークのIPv6対応によっては失敗します。ルートの `bun run deploy` 単体ではmigrationを実行しません。
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

## CI

- `ci.yml`: lint・整形・型検査・テスト・ビルド・DB検証・Playwrightを実行。両ジョブで `bun.lock` をキーにBunのダウンロードキャッシュを共有し、frozen installを行います。ジョブの権限は `contents: read` のみです。
- `codeql.yml`: mainへのpush・PRと週次スケジュールでJavaScript/TypeScriptを解析します。解析ジョブにのみ `security-events: write`、`contents: read`、`actions: read` を付与します。
- `dependabot.yml`: npm（ルート・各workspace）とGitHub Actionsの更新PRを毎週作成します。
- `deploy.yml`: mainへのpush、またはActionsの「Cloudflare deploy」から手動実行（workflow_dispatch）。リポジトリSecretsの `CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID`・`PRODUCTION_DATABASE_URL` を事前確認し、未設定またはSession pooler以外の接続先なら停止します。Bunのfrozen install → Webビルド → 生成忘れ検査（`generate` + `git status`、CIと同じ180秒制限）→ `preflight:production` → 本番migration適用 → SHA-256照合 → WranglerでWorker・静的アセットをデプロイします。権限は `contents: read` のみです。

### migration の適用前ガード

ブランチ保護は採用していません。CIの `check:migrations` は新規SQLへの早期フィードバックで、本番適用経路の `preflight:production` が履歴整合性と適用予定SQLを検査します。CI成功に依存せずデプロイが起動するため、deploy側でも `generate` と未追跡ファイルを含む `git status` で生成忘れを検出します。

journal の `when` は重複なく厳密に増加し、tag も一意である必要があります。本番履歴はローカルjournalの先頭から連続する接頭辞とハッシュ・時刻の両方で一致する必要があります。drizzleはハッシュの有無ではなく、履歴が空なら全件、それ以外は最新 `created_at` より大きい `when` のみを適用します。古い `when` の未記録migrationや適用済みSQLの改変などは適用前に停止し、レビューのマーカーでも許可しません。履歴テーブルが無ければ全件を検査しますが、履歴が無いことはDBが空である証明にはなりません。

破壊的DDLを人間がレビューした場合、適用前のSQLの先頭 `--` コメント欄（SQL開始前、空行可）に `-- destructive-change: reviewed` を追加します。このマーカーは適用前にのみ有効で、適用済みmigrationへの後付け承認には使えません。SQL全文をハッシュ化するため、コメント追記もハッシュを変え、履歴不整合になります。検査はコメントを除去した正規表現による注意喚起で、完全なSQLパーサーではありません。完全なSQL安全性検証ではなく、`ALTER TABLE t DROP c` のような COLUMN 省略形や、DELETE／UPDATEによるデータ破壊を網羅的には検出できません。検出対象には `ALTER TABLE ... RENAME COLUMN ... TO`、`ALTER TABLE ... RENAME TO`、既存カラムの `ALTER COLUMN ... SET NOT NULL`、`DROP SCHEMA`、`DROP VIEW`、`DROP MATERIALIZED VIEW`、`DROP SEQUENCE`、`DELETE FROM` も含みます。新規カラムの `ADD COLUMN ... NOT NULL` は検出対象外です。

migration適用からWorkerデプロイ完了まで、旧Workerが新しいスキーマを使います。破壊的変更、特に削除は「追加 → コード移行 → 後続リリースで削除」の段階的変更を検討してください。
