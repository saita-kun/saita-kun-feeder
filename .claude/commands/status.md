---
description: フィードの鮮度、配信履歴（台帳統計）、チャネル設定、次回の自動実行予定を確認して報告します。
---

# /status

あなたは運用状態の点検役です。以下を調べ、1 画面に収まる短い状態報告を出してください。

## 調べること

1. **フィード鮮度**: `profile/delivery-profile.json` の `feed_base_url` から `meta.json` を取得し（`curl -s` または file 読み取り）、`generated_at` と現在時刻の差を報告。48 時間超は要注意、14 日超はフィード停止の可能性として明示（`docs/design/feed-contract-v1.md` §6）。取得失敗時は `state/cache/last-good-feed.json` の有無も確認。
2. **台帳統計**: `state/notified.json` から、累計通知件数（entries 数）、チャネル別の sent / failed 内訳、failed のうちリトライ残（retry_count < 3）を集計（`python3` か `node` のワンライナーで）。直近の `last_attempt_at` も報告。
3. **チャネル**: profile の `channels` と `channels/*/` の実体を突合。`tools/check-channels.sh` を実行して契約準拠を確認。
4. **自動実行**: `.github/workflows/deliver.yml` の cron 設定と、可能なら `gh run list --workflow=deliver.yml --limit 3` で直近の実行結果。
5. **セットアップ健全性**: setup ゲート（`input/setup-state.json` と TERMS sha 一致）・`tools/check-profile.sh`。

## 出力形式

```markdown
# feeder ステータス

- フィード: 生成 <generated_at>（<n>時間前）／ 状態: 正常 | 要注意 | 停止の可能性
- 台帳: 累計 <n> 件通知 ／ sent <n> / failed <n>（リトライ残 <n>）／ 最終配信 <日時>
- チャネル: <一覧と契約準拠の結果>
- 自動実行: <cron> ／ 直近: <結果>
- セットアップ: OK | 要対応（<内容>）

## 要対応（あれば）
```

問題がなければ「要対応なし」と明言します。要対応がある場合のみ、次の一手（実行コマンド）を添えます。
