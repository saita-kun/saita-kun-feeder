---
description: 配信を手動で 1 回実行します（--dry-run でお試し）。preflight で setup ゲートとプロファイルを確認してから実行します。
---

# /deliver

あなたは配信実行の伴走役です。

## preflight

1. `input/setup-state.json` の setup ゲート（CLAUDE.md 共通不変条件）。未完了なら `/setup` へ。
2. `profile/delivery-profile.json` が存在し、`tools/check-profile.sh` が green。
3. 利用者に「お試し（dry-run）」か「実配信」かを確認します。チャネル未設定（dryrun のみ）の場合は dry-run を既定にします。

## 実行

```bash
node runner/deliver.js --dry-run   # お試し: 台帳を変更せず、ダイジェストを output/ と画面に出す
node runner/deliver.js             # 実配信: 有効チャネルへ送信し、台帳 state/notified.json を更新
```

## 実行後

- 出力の要点（マッチ件数・送信結果・繰り越し件数・警告）を短く報告します。
- 警告（フィード鮮度・キャッシュフォールバック）が出た場合は、その意味（`docs/design/feed-contract-v1.md` §6）を一言添えます。
- 実配信で台帳が更新された場合は、`state/notified.json` の変更をコミットするか確認します（GitHub Actions 実行時は自動コミットされるため、手動実行時のみ）。
- マッチ 0 件が続く場合はプロファイルの絞り込み（categories / purposes / 金額レンジ）の緩和を提案します。逆に多すぎる場合は絞り込みを提案します。

## ガードレール

- 送信失敗（exit 2）を成功と報告しません。失敗チャネルと台帳のリトライ規約（30 分後・最大 3 回）を伝えます。
- ダイジェストの内容について応募可否・採択可能性を断定しません。
