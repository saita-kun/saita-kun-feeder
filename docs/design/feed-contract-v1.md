# 公開データ契約 v1（feed-contract-v1）

> 状態: 有効 ／ 制定日: 2026-07-24 ／ schema_version: **1.0**
> 本文書は、サイタくん補助金公開データフィードの **producer（フィード提供者）と consumer（本ハーネス等の利用系）の間の契約の正本**です。機械可読形は `schemas/feed-meta.schema.json` / `schemas/feed-subsidy.schema.json`、準拠サンプルは `tests/fixtures/feed-sample/`、準拠チェッカは `tools/check-feed-contract.sh`。
> **producer 実装の受け入れ条件 = 実出力が `tools/check-feed-contract.sh` を通ること。**

## 1. 配置（CDN 上のファイルレイアウト）

```
<FEED_BASE>/v1/meta.json           # 小さい・consumer は毎回取得
<FEED_BASE>/v1/subsidies.json.gz   # 全件ダンプ（gzip 済み明示アーティファクト）
```

- **認証なし**・CORS `*`・`Cache-Control: max-age=3600` 以下。HTTP GET のみで取得できること。
- URL は安定させる。クエリ文字列によるバージョニングは禁止。破壊的変更は `/v2/` を**並存**で立て、v1 は非推奨期間中 `meta.deprecated: true` を立てて維持する。
- `.gz` を明示アーティファクトとするのは、CDN の transparent content-encoding に依存すると sha256 検証対象のバイト列が不定になるため。producer は gzip 後のバイト列をそのまま配置する。
- producer サイトのルート `llms.txt` に「公開データフィード」節を設け、`meta.json` の URL と本契約文書（canonical repo 上の絶対 URL）へリンクする。

## 2. meta.json

```json
{
  "schema_version": "1.0",
  "contract_url": "https://github.com/saita-kun/saita-kun-feeder/blob/main/docs/design/feed-contract-v1.md",
  "generated_at": "2026-07-24T22:05:00Z",
  "row_count": 13698,
  "files": {
    "subsidies.json.gz": {
      "bytes": 2345678,
      "sha256": "<gzip バイト列の sha256>",
      "sha256_uncompressed": "<展開後 JSON バイト列の sha256>"
    }
  },
  "license": "CDLA-Permissive-2.0",
  "attribution": "サイタくん 補助金公開データフィード",
  "deprecated": false
}
```

- `generated_at` は UTC の ISO 8601（`Z` 終端）。
- `row_count` は subsidies の件数と一致すること（consumer が検証する）。

## 3. subsidies.json（展開後）

```json
{
  "schema_version": "1.0",
  "generated_at": "<meta.json と同値>",
  "subsidies": [ { ...row }, ... ]
}
```

ヘッダを data ファイル内にも重複させるのは、meta/data のスキュー（別世代の混在）を consumer が検出できるようにするため。`schema_version` と `generated_at` は meta.json と**完全一致**しなければならない。

### 3.1 エクスポート対象行

**`is_open = true` かつ掲載 URL が生きている行のみ**（サイタくん実装では `is_open = true AND url_dead_since IS NULL`）。closed 行を含めない。consumer は「フィードから消えた id = 掲載終了」と解釈してよい（台帳側で保持し、再掲載時の誤爆を防ぐのは consumer の責務。dr-006）。

### 3.2 row フィールド（全列）

追加のフィールドを持ってはならない列挙ではない（§5 の互換性ルール参照）が、v1 の必須・意味は以下の通り。

| フィールド | 型 | 必須 | 意味・備考 |
|---|---|---|---|
| `id` | string | ✔ | 行の安定識別子。整数由来でも**文字列**として出力する（台帳キー・JSON キーとの整合） |
| `detailed_url` | string | ✔ | 一意。掲載元の詳細 URL。ダイジェストのリンク先 |
| `title` | string | ✔ | |
| `description` | string \| null | | |
| `prefectures` | string[] | ✔ | romaji（`hokkaido`〜`okinawa`）+ sentinel `"zenkoku"`。§4.3 |
| `municipality` | string \| null | | 抽出値・表記ゆれあり。**包含マッチ前提**（consumer は完全一致で扱わない） |
| `gov_level` | string | ✔ | `national` / `prefecture` / `municipal` |
| `application_deadline` | string \| null | | §4.1 の sentinel 規約 |
| `acceptance_start` | string \| null | | |
| `maximum_amount` | number \| string \| null | | §4.2 の sentinel 規約 |
| `funding_limit` | string \| null | | 表示用の補足（上限の但し書き等） |
| `subsidy_rate` | string \| number \| null | | 数値化可能な場合のみ rate フィルタで評価される |
| `eligible_scale` | string \| null | | `small` / `sme` / `any` / null |
| `support_type` | string \| null | | |
| `institution_name` | string \| null | | 発行主体の表示用 |
| `category_<key>` | 0 \| 1 | ✔ ×12 | key = `new_technology, it, entertainment, professional, agriculture, construction, wholesale, finance, realestate, hospitality, medical, other` |
| `purpose_<key>` | 0 \| 1 | ✔ ×7 | key = `capex, it_intro, rd, hr, market, startup, succession` |

**出さない列**（producer の内部事情を契約面に漏らさない）: 内部パイプライン識別子（`source` 等）、`is_open`（open 行のみ出すため冗長）、`url_dead_since`（dead 行は出さない）、内部タイムスタンプ。**行別の updated_at は契約に含めない** — 差分検出は consumer 側の content hash で行い、producer のタイムスタンプ運用に依存させない。

## 4. sentinel 規約（MUST）

1. **application_deadline**: 締切が既知なら `YYYY-MM-DD`。それ以外（`"No information"` 等の sentinel 文字列・null・非 ISO 形式）はすべて「**締切不明**」を意味する。consumer は「`^\d{4}-\d{2}-\d{2}$` に合致しなければ不明」として解釈しなければならない。締切不明の行は open 判定から保守的に除外される（vendored `parseDeadline` / `isOpen` の挙動が正）。
2. **maximum_amount**: null / 空文字 / 数値化不能 / **数値として ≤ 1** は「**金額不明**」を意味する（抽出器の sentinel `1` 規約）。金額不明時、金額軸のフィルタはスキップ（= 含める）が正しい解釈（vendored `isAmountUnknown` が正）。
3. **prefectures と gov_level の不変条件**: `gov_level = 'national'` ⇔ `prefectures = ["zenkoku"]`。この書き込み不変条件は **producer が保証**する。
4. **NULL の一般原則**: null / 欠落は「制約なし・情報なし」を意味し、「該当なし」を意味しない。

## 5. バージョニングと互換性

- `schema_version` は `major.minor`。
  - **minor**（1.0 → 1.1）: 後方互換の追加（フィールド追加・enum 値追加）。consumer は未知フィールドを無視しなければならない。
  - **major**（1.x → 2.0）: 破壊的変更。`/v2/` パスを新設して並存させる。
- consumer は major が想定と異なるフィードを処理してはならない（エラーにする）。

## 6. 鮮度・整合性（consumer の義務）

- **鮮度**: producer は日次生成する（`generated_at` は常時 26h 以内が期待値）。consumer は
  - **48h 超**: ダイジェストに stale バナー（「フィードが古い可能性」）を出す。配信は継続する。
  - **14 日超**: 「フィード停止の可能性」を明示警告する。それでもハードフェイルはしない（dr-004 の劣化継続）。
- **整合性**: consumer は取得した `.gz` の sha256 を meta.json と照合してから parse する。不一致・取得失敗・parse 失敗時は、直近正常版のローカルキャッシュで継続し、警告を surface する。
- **スキュー検出**: data ヘッダの `generated_at` / `schema_version` が meta.json と一致しない場合は不整合として扱う（キャッシュにフォールバック）。

## 7. ライセンス

- フィードのデータライセンスは **CDLA-Permissive-2.0**（親規範: saita-kun-planner `docs/governance/data-charter.md` — 生フィード無料公開 §8・配布ライセンス統一）。
- meta.json の `license` フィールドと本契約文書の両方で宣言する。
- コード（Apache-2.0）とデータ（CDLA-Permissive-2.0）は別レイヤ（TERMS.md 冒頭の三層宣言）。
- 出所表示（`attribution`）は推奨（CDLA-Permissive は義務ではない）。

## 8. producer 実装への引き渡し物

1. 本契約文書
2. `schemas/feed-meta.schema.json` / `schemas/feed-subsidy.schema.json`（JSON Schema draft 2020-12）
3. `tests/fixtures/feed-sample/`（準拠サンプル。sentinel ケースを網羅）
4. `tools/check-feed-contract.sh`（準拠チェッカ。**producer の CI に組み込むこと**）
