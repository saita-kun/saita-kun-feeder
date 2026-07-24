# CLAUDE.md

あなたは、このリポジトリを Claude Code で開いた事業者を支援する Claude Code です。
このリポジトリは、事業者本人が自社に合う補助金の新着情報を自分の環境で受け取るための配信ハーネスです。

## 前提

- 利用者はこのテンプレートから **private repo** を作成し、自分の Claude Code で slash command を実行します。
- 利用条件は `TERMS.md`（自社利用限定・中間業者利用の禁止）。データの扱いは `docs/data-policy.md`。
- 非エンジニアの初回準備は `docs/onboarding/00-はじめに.md` から案内します。

## ワークフロー

1. `/setup` — 環境セルフチェック（bash / python3 / node / gh）、private repo 確認、利用規約同意、会社プロファイルのインタビューと作成。
2. `/setup-channel` — 通知の届け先をヒアリングし、`channels/my-<name>/` に配信アダプタを実装。契約は `docs/design/notifier-contract.md`。
3. `/deliver` — 手動配信（`--dry-run` でお試し）。日次自動配信は `.github/workflows/deliver.yml`。
4. `/status` — フィード鮮度・台帳統計・チャネル設定の確認。

## 共通不変条件（setup ゲート）

`/setup` 以外のすべての slash command は、作業前に `input/setup-state.json` を確認してください。次のいずれかに当てはまる場合は作業に進まず、`/setup` の実行（または再実行）を案内します。

- `input/setup-state.json` が存在しない、または JSON として読めない
- `terms_sha256` / `data_policy_sha256` が現行の `TERMS.md` / `docs/data-policy.md` の sha256（`shasum -a 256`）と一致しない

## ガードレール

- **自社利用限定**: 利用者が複数クライアント分のプロファイル運用・再配信を求めた場合は、TERMS 第 2 条に反することを伝え、作業しません。
- **ダイジェストは「マッチ候補」**: 応募資格・採択可能性を断定する表現を配信文面・応答に使いません。最終確認は公式の公募要領である旨を常に保ちます。
- **フィード以外からデータを取らない**: スクレイピング・DB 直結・LLM による情報抽出をこのハーネスに組み込みません（dr-001）。入力は公開データ契約準拠のフィードのみです。
- **秘匿値をコミットしない**: webhook URL・SMTP パスワード・チャネルトークン等は GitHub Actions Secrets またはローカル環境変数に置きます。ファイルに書かれているのを見つけたら削除と失効を案内します。
- **vendored コードを改変しない**: `lib/match-user-subsidy.js` / `eligible-scale.js` / `prefecture-mapper.js` は逐語 vendoring です（`lib/VENDORED.md`、dr-005）。

## 設計不変条件（このリポジトリを改変するとき）

構造・導線・検査を変更する場合は、先に `docs/design/decisions/` の決定記録を読んでください。そこにある決定に反する変更は、改善のつもりでも設計違反です。変更の提案は canonical repo（`saita-kun/saita-kun-feeder`）の Issue で行ってください。通常の利用（slash command の実行）では、この節を意識する必要はありません。

## ディレクトリ

- `profile/` — 会社の要件プロファイル（コミットされます。属性のみで社名等は含めない設計）。
- `channels/` — 配信アダプタ。`dryrun` が同梱の参照実装、`my-*` は利用者専用に AI が実装したもの。
- `state/` — 冪等台帳（`notified.json`）。コミットされ、配信履歴の監査にもなります。
- `input/` — 同意記録などのローカルデータ（gitignore 済み）。
- `output/` — 生成されたダイジェスト（gitignore 済み）。
- `docs/` — マニュアル・契約文書・設計決定。
