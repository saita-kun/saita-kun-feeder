# DR-006: ローカル台帳による冪等配信

> 種別: 設計不変条件 ／ 状態: 有効 ／ 決定日: 2026-07-24 ／ 決定者: DRI

## 決定

配信の冪等性は、repo にコミットされるローカル台帳 `state/notified.json`（`schemas/ledger.schema.json`）で担保する。意味論はサイタくん本体の SQL クレームモデル（`notification_log`）をファイルに移植したもの: 送信単位は `(subsidy_id, channel)`、結果は `sent | failed`、failed は `retry_count < 3` かつ前回試行から 30 分超で再送候補。差分検出は行の **content hash**（hash 対象フィールドは ledger schema に固定列挙）で行い、`new`（台帳未登録）と `updated`（hash 変化）だけを配信する。

## 理由

- サーバーレス（GitHub Actions / cron）で「同じ補助金を二度送らない」「失敗を数回だけ再試行する」を成立させるには、実行間で永続する状態が必要。repo コミットは GHA と最も自然に両立し、配信履歴が git log としてそのまま監査可能になる。
- content hash による updated 判定は、producer のタイムスタンプ運用に依存しない（契約に行別 updated_at を要求しない）。hash 対象を固定列挙するのは、description の軽微な文言修正で再通知の嵐にならないようにするため。
- 台帳は subsidy id と hash のみを含み、個社情報（プロファイル・応募状況）を含まない。private repo へのコミットに追加のリスクを持ち込まない。

## 制約（運用 AI が守ること）

- 台帳スキーマの変更は `ledger_version` を上げ、旧版からの読み替え（migration）を `lib/ledger.js` に実装してから行う。
- hash 対象フィールドの変更は「全行が updated 扱いになり再通知が走る」ことを意味する。変更時は初回実行で `notified_as: updated` の再通知を抑止する移行手順とセットで行う。
- 台帳に個社情報・チャネル秘匿値を書き込まない。

## 違反例

- 「毎回全件送ればシンプル」と台帳チェックを外す。
- フィードから消えた行を台帳からも即削除する（→ 残す。再掲載時に new 扱いで誤爆させないため）。
