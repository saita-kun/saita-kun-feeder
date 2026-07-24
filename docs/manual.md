# マニュアル

日常運用のリファレンスです。初回準備は `docs/onboarding/00-はじめに.md`、コマンドの詳細は `.claude/commands/` を参照。

## 全体像

```
公開データフィード（CDN・日次更新）
  → 取得 + sha256 検証（lib/feed-client.js。失敗時は state/cache/ で劣化継続）
  → open 判定 + プロファイルとマッチング（lib/match-user-subsidy.js — 本体配信エンジンと同一コード）
  → 台帳と突合して新着/更新だけ選別（state/notified.json、週15/日5 上限）
  → ダイジェスト生成（output/digest-<日付>-<チャネル>.md / .json）
  → チャネルアダプタが送信（channels/<name>/send）
```

## 日次自動配信（GitHub Actions）

`.github/workflows/deliver.yml` が毎日 22:00 UTC（JST 07:00）に実行します。

- 実行条件: repo が private・`profile/delivery-profile.json` がサンプルでない・TERMS 同意 sha が一致
- 実行後、台帳 `state/notified.json` の変更を bot が自動コミットします
- チャネルの秘匿値は repo の Secrets に置き、`deliver.yml` の `env:` で渡します（`/setup-channel` が案内）
- 手動発火: Actions タブから `Run workflow`（workflow_dispatch）

## ローカル cron で動かす（GitHub Actions を使わない場合）

ランナーは GitHub Actions への依存を持ちません。手元の cron でも同じように動きます:

```bash
# 毎朝 7 時に実行する例（crontab -e）
0 7 * * * cd /path/to/your-feeder && node runner/deliver.js && git add state/notified.json && git commit -m "chore: update delivery ledger" >/dev/null
```

チャネルの環境変数は cron 環境に設定してください。

## ランナーの引数

```bash
node runner/deliver.js [--dry-run] [--today YYYY-MM-DD] [--feed <url|dir>] \
                       [--profile <path>] [--ledger <path>] [--out <dir>]
```

- `--dry-run`: 台帳を変更せず、アダプタも副作用なしモード（`SAITA_FEEDER_DRY_RUN=1`）で起動
- `--today`: 基準日を固定（テスト・検証用）
- exit code: 0 = 正常 / 1 = 致命的エラー / 2 = 一部送信失敗（台帳に failed 記録、30 分後以降の実行で最大 3 回再送）

## プロファイルの調整

`profile/delivery-profile.json` を編集し、`tools/check-profile.sh` で検証します。絞り込み軸の意味（NULL = 制約なし・部分一致 = いずれか一致）は `schemas/delivery-profile.schema.json` の説明を参照。編集後はコミットを忘れずに（GitHub Actions が読むため）。

## 上流更新の取り込み（ハーネスの育て方）

コア層（`core-manifest.json` の `core_paths`）は上流テンプレートの改善で更新されることがあります。取り込みは `tools/update-core.sh` を実行し、育成層（profile / state / channels/my-* / input / output）が触られていないことを diff で確認してからコミットします。

## トラブルシュート

| 症状 | 見る場所 |
|---|---|
| 配信が来ない | `/status` → フィード鮮度・台帳・Actions 直近実行 |
| 「同意記録が一致しません」 | TERMS.md が更新されています。`/setup` で再同意 |
| 警告: キャッシュで継続 | フィード取得失敗。一時的なら次回自動回復。継続するなら `/status` で鮮度確認 |
| 送信失敗（exit 2） | チャネルの Secrets 設定・`tools/check-channels.sh`。台帳が自動で最大 3 回再送 |
| マッチが多すぎ/少なすぎ | プロファイルの categories / purposes / 金額レンジを調整 |
