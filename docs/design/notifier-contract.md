# notifier 契約（チャネルアダプタ契約 v1）

> 状態: 有効 ／ 制定日: 2026-07-24 ／ contract_version: **1**
> 機械可読形: `schemas/channel-manifest.schema.json` ／ 準拠検査: `tools/check-channels.sh` ／ 設計判断: [dr-002](decisions/dr-002-no-bundled-channels.md)

配信チャネル（Slack・メール・LINE 等）は**コア層に同梱されない**。利用者の AI が `/setup-channel` のヒアリングを経て `channels/my-<name>/` に生成する。本文書は、生成されるアダプタが満たすべき契約の正本である。

## 1. アダプタの構成

```
channels/<name>/
├── channel.json   # マニフェスト（schemas/channel-manifest.schema.json 準拠）
└── send           # 実行可能スクリプト（言語自由。実行ビット必須）
```

- `channel.json.name` はディレクトリ名と一致すること。
- 利用者生成のアダプタは `my-` プレフィックス（例: `my-slack`）を推奨。`dryrun` はコア層唯一の同梱チャネル（参照実装）。

## 2. 呼び出し規約

```
send <digest.md のパス>
```

- **argv[1]**: 描画済みダイジェスト（markdown）のファイルパス。
- **stdin**: ダイジェストの機械可読 JSON（`lib/digest.js` の `json` 出力。`digest_version: 1`）。
- **exit 0 = 配信成功／非 0 = 失敗**。失敗はランナーが台帳に `failed` として記録し、リトライ規約（30 分バックオフ・最大 3 回）を適用する。
- タイムアウト: 60 秒。超過は失敗扱い。
- 冪等性（同じ補助金を二度送らない）は**ランナー側の台帳が担保**する。アダプタは渡されたものを送るだけでよい。

## 3. SAITA_FEEDER_DRY_RUN（MUST）

環境変数 `SAITA_FEEDER_DRY_RUN=1` がセットされている場合、アダプタは**ネットワーク副作用を一切起こさず**、「何をするつもりか」を stdout に出力して exit 0 しなければならない。`/deliver --dry-run` と `tools/check-channels.sh` はこのモードで起動する。

## 4. 秘匿値の扱い（MUST）

- webhook URL・トークン・SMTP 認証情報等は、**ファイルに書かない**。`channel.json` の `requires_env` に必要な環境変数**名**を宣言し、値は GitHub Actions Secrets（`deliver.yml` の `env:` 経由）またはローカル環境変数から受け取る。
- `send` は起動時に `requires_env` の変数が空でないことを確認し、欠落時はその旨を stderr に出して非 0 で終了することを推奨（DRY_RUN 時は欠落しても exit 0 でよい）。

## 5. 機械検証（チャネルの中身を知らずに判定できること）

`tools/check-channels.sh` は全 `channels/*/` について以下を検査する:

1. `channel.json` がスキーマ準拠（name = ディレクトリ名を含む）
2. `send` に実行ビットが立っている
3. `SAITA_FEEDER_DRY_RUN=1` + fixture digest での起動が exit 0

これに通らないアダプタは `validate.yml` で fail する。

## 6. 生成時の注意（/setup-channel が守ること）

- 依存は最小に。可能な限り OS 標準（bash + curl 等）で書き、パッケージインストールを要求しない。
- 送信文面にダイジェストの免責定型文（マッチ候補であって認定ではない）を残す。要約して削らない。
- 実送信テストは利用者の確認を取ってから 1 回だけ行う。
