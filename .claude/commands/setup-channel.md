---
description: 通知の届け先（Slack・メール・LINE 等）をヒアリングし、channels/my-<name>/ に利用者専用の配信アダプタを実装してテストまで行います。
---

# /setup-channel

あなたは、利用者の環境に合わせた配信チャネルアダプタを実装するエンジニア役です。**契約の正本 `docs/design/notifier-contract.md` を最初に読み**、そこに書かれた MUST（呼び出し規約・DRY_RUN サポート・秘匿値の扱い）を満たすアダプタを生成してください。

## preflight

- `input/setup-state.json` の setup ゲート（CLAUDE.md 共通不変条件）を確認。未完了なら `/setup` へ。
- `profile/delivery-profile.json` が存在し `tools/check-profile.sh` が green であること。

## 1. ヒアリング

短く聞きます（一度に全部聞かず、答えに応じて絞り込む）:

1. 「通知はどこに届くと便利ですか？」（例: Slack / Discord / メール / LINE / Microsoft Teams / その他）
2. その環境の具体:
   - Slack/Discord/Teams → incoming webhook を作成できるか（作成手順の案内も可）
   - メール → 使える SMTP サーバーがあるか（プロバイダ・ポート・認証方式）
   - LINE → 自社の LINE 公式アカウント（Messaging API チャネル）を持っているか
   - その他 → 送信に使える API・CLI があるか
3. 全文を届けるか、件名＋リンク程度の短文にするか

## 2. アダプタ生成

`channels/my-<name>/`（例: `my-slack`）に以下を作成します:

- `channel.json` — `schemas/channel-manifest.schema.json` 準拠。秘匿値は書かず、必要な環境変数**名**を `requires_env` に列挙。
- `send` — 実行可能スクリプト（`chmod +x`）。依存は最小に。追加のパッケージインストールを要求せず、`/setup` の環境セルフチェックで存在を確認済みのランタイムで書く（POSIX 環境なら bash + curl、本キット必須の node でもよい）。契約の要点:
  - argv[1] = digest markdown パス、stdin = digest JSON
  - exit 0 = 成功 / 非 0 = 失敗
  - `SAITA_FEEDER_DRY_RUN=1` なら副作用ゼロで意図を stdout に出して exit 0
  - `requires_env` の変数が空なら stderr にその旨を出して非 0（DRY_RUN 時を除く）
  - ダイジェストの免責定型文を削らない

## 3. 秘匿値の登録案内

- ローカル実行用: シェルの環境変数設定を案内（値はチャットに貼らせない。`read -s` 等を案内）。
- 自動配信用のゴール: **有効チャネルの `requires_env` が GitHub Actions の実行時に解決される状態**。次の 2 つを両方行います。
  1. Secrets に値を登録する。手段は 2 経路のどちらでもよい:
     - `gh` があれば `gh secret set <NAME>`（値の入力はプロンプトに直接。チャットに貼らせない）
     - `gh` が無ければブラウザで repo の **Settings > Secrets and variables > Actions > New repository secret** に `<NAME>` と値を登録してもらう
  2. `.github/workflows/deliver.yml` の Deliver ステップに `env:` を追記し、その Secret を変数として渡す（コメントアウトされた例が同ファイルにあります）。この追記はアダプタとセットで行います。

## 4. テスト（4 段階）

1. **契約検査**: `tools/check-channels.sh` green。
2. **DRY_RUN 自己テスト**: 本番と同じ入力（argv[1] = digest markdown、stdin = digest JSON）で起動します。

   ```bash
   SAITA_FEEDER_DRY_RUN=1 channels/my-<name>/send tests/fixtures/golden-digest/digest-2026-07-10-dryrun.md \
     < tests/fixtures/golden-digest/digest-2026-07-10-dryrun.json
   ```

   受入基準: exit 0 であること／stdout に「どこへ何件送るつもりか」（送信先と件数）が出ること／ネットワーク副作用が無いこと（契約 §3 の MUST）。stdin を `/dev/null` にしないでください — 契約 §2 は stdin = ダイジェスト JSON と定めており、`tools/check-channels.sh` も同じ fixture JSON を stdin に流して起動するため、空 stdin で試すと契約準拠のアダプタだけが落ちて誤った「修正」を招きます。
3. **実送信テスト**: 利用者に「1 回だけテスト送信して良いか」を確認してから、golden digest fixture を実送信し、届いたことを利用者に確認してもらう。
4. **自動配信の疎通確認**: Actions タブから deliver ワークフローを `Run workflow`（workflow_dispatch）で 1 回手動実行し、緑になることを確認します。受入基準は「`gh secret list` か Settings 画面で Secret 名が見えること」＋「この手動実行が緑であること」。`tools/validate.sh` は `deliver.yml` を一切検査しないため、**手順 3 の `env:` 追記が正しいことを機械的に確かめられるのはこの手動実行だけ**です（追記が壊れていても日次配信は無言で止まります）。

## 5. 有効化

`profile/delivery-profile.json` の `channels` に `{"name": "my-<name>", "enabled": true}` を追記し、`tools/check-profile.sh` green を確認。dryrun を残すか無効化するかを利用者に確認します。最後に変更一式をコミットするか確認します（秘匿値が含まれていないことを diff で確認してから）。

## ガードレール

- 秘匿値（webhook URL・トークン・パスワード）をファイル・チャット出力・コミットに含めません。既に貼られてしまった場合は、値の失効（ローテーション）を案内します。
- 送信先が「クライアントへの一斉配信」である場合は TERMS 第 2 条（自社利用限定）に反するため実装しません。
- コア層（`channels/dryrun/`・`runner/`・`lib/`）は変更しません（dr-002・dr-005）。
