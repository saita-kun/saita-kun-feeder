# DR-005: 判定ロジックは web 由来 JS の逐語 vendoring

> 種別: 設計不変条件 ／ 状態: 有効 ／ 決定日: 2026-07-24 ／ 決定者: DRI

## 決定

マッチング判定の中核（`lib/match-user-subsidy.js` / `eligible-scale.js` / `prefecture-mapper.js`）は、サイタくん配信エンジンからの**逐語コピー**（vendoring）とし、feeder 側での改変・「改善」・他言語への移植を禁止する。挙動の正は `tests/fixtures/match-predicate-golden/` の golden fixtures。再同期は `lib/VENDORED.md` の手順に従い、fixtures green のみを受け入れ条件とする。

## 理由

- この判定ロジックには sentinel・境界値・緩めマッチの微妙な判断（amount ≤1 は不明として「含める」、締切当日は open、municipality の双方向包含、includeNationwide 既定 TRUE、業種連動の規模しきい値）が織り込まれており、golden fixtures で固定された実戦品質のコードである。
- fixture 名自体が「jq 移植との既知の乖離」を記録している（`01-amount.json`）。**移植は一度この乖離を実際に生んだ操作**であり、再移植は同じリスクの再導入になる。逐語コピーなら fixtures がそのまま無改変の証明になる。
- 本体（サイタくん LINE 配信）と feeder で判定結果が一致することは、利用者への説明可能性（同じ条件なら同じマッチ）そのもの。

## 制約（運用 AI が守ること）

- vendored 3 ファイルに対する Edit を行わない。lint 修正・スタイル統一も不可。
- 判定の不具合を見つけた場合は upstream（saita-kun-web）への報告として整理し、修正は upstream → 再 vendoring の経路で取り込む。
- golden fixtures の expected を書き換えて red を消さない。

## 違反例

- 「Python の方がツール群と揃うから」という理由での移植。
- feeder 固有の要望（新フィルタ軸）を vendored ファイルへ直接追加する（→ 新フィルタは vendored 層の外、`lib/select.js` 等の feeder 層で行う）。
