# 設計決定記録（Decision Records）

このディレクトリは、saita-kun-feeder の**設計不変条件**を記録します。fork 先の AI がこのリポジトリを改変するとき、ここにある決定に反する変更は「改善のつもりでも設計違反」です。矛盾する変更は、該当 DR の改訂とセットでのみ行ってください。

| # | タイトル | 種別 |
|---|---|---|
| [dr-001](dr-001-feed-contract-only.md) | 入力は公開データ契約経由のみ（DB 直結・スクレイプ・LLM 抽出の非同梱） | 設計不変条件 |
| [dr-002](dr-002-no-bundled-channels.md) | 配信チャネル非同梱・AI 生成アダプタ方式 | 設計不変条件 |
| [dr-003](dr-003-self-use-only.md) | 自社利用限定（中間業者利用の禁止） | 利用条件の設計根拠 |
| [dr-004](dr-004-upstream-feed-dependency.md) | 上流フィード依存の緩和（feeder 版自走条項） | 設計不変条件 |
| [dr-005](dr-005-verbatim-vendoring.md) | 判定ロジックは web 由来 JS の逐語 vendoring | 設計不変条件 |
| [dr-006](dr-006-local-ledger-idempotency.md) | ローカル台帳による冪等配信 | 設計不変条件 |

形式は姉妹 repo saita-kun-planner の `docs/design/decisions/` に準じます。
