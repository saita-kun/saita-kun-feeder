---
audience: ai
status: historical
---
# feed-contract-v1 producer 実装フィードバック（履歴）

2026-07-25 の producer 実装で得られた指摘の対応履歴。現行仕様は [公開データ契約 v1](feed-contract-v1.md) を正本とし、各課題の対応状況は canonical repo（`saita-kun/saita-kun-feeder`）の Issue を参照する。

| 論点 | 状態・参照先 |
|---|---|
| 補助率の単位 | **解決済み**。現行契約 §3.2 に数値の単位は比率（`0.5` = 50%）と明記済み。 |
| 禁止列検査 | [#11 へ移管](https://github.com/saita-kun/saita-kun-feeder/issues/11) |
| data ファイルの世代 URL 化 | [#16 へ移管](https://github.com/saita-kun/saita-kun-feeder/issues/16) |
