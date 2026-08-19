# feed-contract-v1 producer 実装フィードバック（2026-07-25）

> **対象読者: canonical repo（`saita-kun/saita-kun-feeder`）のメンテナ AI。採用者 repo では作業対象外です。** テンプレートから作った自分の repo でこの文書を読んだ場合、ここに書かれた契約文書の改訂・checker の変更は行わないでください（`CLAUDE.md`「設計不変条件」のとおり、提案は canonical repo の Issue へ）。

producer（saita-kun-web [PR #168](https://github.com/HideTsug/saita-kun-web/pull/168)、Phase A2）の実装が完了し、`tools/check-feed-contract.sh` を vendor して CI ゲート化・準拠 pass 済み。実装レビュー（GPT-5.6 Sol・3巡）で確定した**契約側への申し送り**を記録する。以下は canonical repo 側で処理すべき未処理の申し送りである（参照先の PR は producer repo のもので、採用者からは参照できない）。

## 実装報告

- 実配置: `FEED_BASE = <Vercel Blob 公開オリジン>/feed`（`feed/v1/meta.json` + `subsidies.json.gz`、`cacheControlMaxAge: 3600`、meta が pointer-last）
- llms.txt: www ルートに新設済み（meta.json と本契約文書へリンク）
- 実効行数: エクスポート対象 13,701 行中、契約必須項目を満たせない行を除外して**約 11,575 行**
  - title 欠落 2,040（**全行 description も空**のメタデータのみ行。ダイジェスト表示に使えない）
  - 地域未確定（prefectures 空 + gov_level null）84
  - gov_level=national × 地域指定の矛盾 2（解消先が決められず除外・warn）
  - zenkoku 混在 3 行は `national` / `["zenkoku"]` へ repair（§4.3 は producer 側で保証済み）
  - 除外集計は producer のジョブ応答 `feed_excluded` と cron warn ログで観測可能

## 契約側への修正依頼

1. **§3.2 subsidy_rate の単位明記（重要）** — 契約文書に単位の記載がない。feed-sample と vendored `match-user-subsidy` は比率（`0.5` = 50%）前提、producer DB は percent（`50` = 50%）保存。producer は **percent→比率へ正規化（小数第4位丸め）して出力する**実装で確定したので、§3.2 に「比率（0.5 = 50%）」を明記すること（明記されるまで両者の暗黙合意状態）。
2. **checker の禁止列検証（P2）** — `check_feed_contract.py` は出力禁止列（`source` / `is_open` / `url_dead_since` / 内部 timestamp）を拒否せず、schema も `additionalProperties: true`。producer 側はフィールド集合完全一致テストで防御済みだが、契約ゲートとして checker に禁止キー検証を追加推奨。追加されたら producer 側で再 vendor する（`apps/backend/tools/feed-contract/` に出所ヘッダ付きで vendor 中）。
3. **v2 論点: data ファイルの世代 URL 化** — data が固定 URL のため gz→meta の 2 段 put 間の失敗窓（ペア不整合）が構造的にゼロにできない。v1 は §6 の sha256 照合 + キャッシュフォールバックで劣化継続できるため許容とした。v2 で immutable な世代 URL + manifest 方式を検討。
4. **repo 公開が feed 有効化のブロッカー** — `contract_url`（github.com/saita-kun/saita-kun-feeder）が 2026-07-25 時点で 404（repo 未公開）。meta.json / llms.txt のリンクが切れるため、producer 側デプロイ前提（PR #168 #4）に「feeder repo の GitHub 公開」を積んである（DRI 判断待ち）。
