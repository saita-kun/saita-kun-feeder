# DR-002: 配信チャネル非同梱・AI 生成アダプタ方式

> 種別: 設計不変条件 ／ 状態: 有効 ／ 決定日: 2026-07-24 ／ 決定者: DRI

## 決定

配信チャネル（Slack・メール・LINE 等）の実装をコア層に同梱しない。コア層が持つのは、①アダプタ契約（`docs/design/notifier-contract.md` + `schemas/channel-manifest.schema.json`）、②決定的な dry-run チャネル（`channels/dryrun/`）、③契約準拠を機械検証する `tools/check-channels.sh`、の 3 点のみ。実チャネルは、利用者の AI が `/setup-channel` で環境をヒアリングして `channels/my-<name>/` に生成する。

## 理由

- 利用者環境（Slack か Teams か、SMTP があるか、LINE 公式アカウントを持つか）は多様で、全チャネルの網羅は原理的に不可能。半端な同梱は「動かない公式実装」を生み、それがハーネス全体の品質評価を下げる。
- AI が利用者の実環境に合わせて書いたアダプタ + 契約検証 + dry-run テストの組み合わせは、汎用実装より利用者環境での動作品質が高い。
- テスト可能性は dryrun チャネルが担う。E2E・golden digest はチャネル実装に依存せず成立する。

## 制約（運用 AI が守ること）

- コア層に特定チャネルの実装・SDK 依存を追加しない。
- アダプタ契約を破壊的に変更する場合は `contract_version` を上げ、`/setup-channel` の再生成手順とセットで行う。
- 生成アダプタには `SAITA_FEEDER_DRY_RUN=1` サポート（副作用なし実行）を必ず実装させる（契約の MUST）。

## 違反例

- 「よく使われるから」と `channels/slack/` をコア層に追加する。
- 契約検証を通らない送信スクリプトを `runner/deliver.js` から直接呼ぶ特例を作る。
