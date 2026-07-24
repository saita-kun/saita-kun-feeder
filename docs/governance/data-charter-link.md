# データ憲章（参照）

サイタくんプロジェクトのデータガバナンスの正本は、姉妹 repo saita-kun-planner の
[`docs/governance/data-charter.md`](https://github.com/saita-kun/saita-kun-planner/blob/main/docs/governance/data-charter.md) です。feeder はその派生プロジェクトとして次の条項に従います。

## feeder に直接関わる条項（自己完結のための転記）

- **生フィードの無料公開**（憲章 §8）: 構造化した補助金フィード（レジストリ）は無料公開し、OSS 利用者が検証できる形で維持する。feeder が消費する公開データフィード（`docs/design/feed-contract-v1.md`）はこの条項の実装である。
- **集計データの外部配布ライセンス = CDLA-Permissive-2.0**（憲章 §6 関連）: feeder のフィードも同ライセンスで統一する。
- **採否データの row-level 公開禁止**（憲章 §6）: 採否（result）データは feeder のスコープに一切含めない。feeder は採否データを収集も配信もしない。
- **スポンサー独立**（憲章 §7）: フィードの掲載・順序は資金提供の影響を受けない。feeder 側でも並び順は決定的ルール（締切昇順 → 金額降順 → id）のみで決まり、優先表示の仕組みを持たない。

## feeder 固有の追加原則

- テレメトリなし・収集なし（TERMS 第 3 条）。データは一方向（producer → 利用者）にのみ流れる。
