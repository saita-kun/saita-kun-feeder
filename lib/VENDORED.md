# Vendored matching logic（逐語 vendoring 台帳）

このディレクトリの以下 3 ファイルは、サイタくん配信エンジン（closed-source repo
`saita-kun-web`）から**逐語コピー**した純関数モジュールです。著作権者（サイタくん
プロジェクト）自身が Apache-2.0 で本 repo に再ライセンスして同梱しています。

**改変禁止**（dr-005）。挙動の正は `tests/fixtures/match-predicate-golden/` の
golden fixtures であり、fixtures が green であることだけが再同期の受け入れ条件です。

## 台帳

| ファイル | 由来（upstream パス） | コピー時 upstream sha256 | コピー日 |
|---|---|---|---|
| `match-user-subsidy.js` | `apps/backend/lib/match-user-subsidy.js` | `c3dddd7abe8232c720bc41c9fe2d9dcd6cb8474b79a238594983efaa848bd539` | 2026-07-24 |
| `eligible-scale.js` | `apps/backend/lib/eligible-scale.js` | `11718e9d2dd4a909ad7329a868a2f979b0017e83478e99d81d432a864ed6ed25` | 2026-07-24 |
| `prefecture-mapper.js` | `apps/backend/lib/prefecture-mapper.js` | `2e07cbc845c06c28926452fac3c8e4fc1c6cb339fc8a7ca604162c041573c9f0` | 2026-07-24 |
| `../tests/match-predicate-golden.test.js` | `apps/backend/tests/match-predicate-golden.test.js` | `082ca9bdaa8b651b58b56bfcd3eab4ad060a60dacd9e72bbf5fd1e28eaf53284` | 2026-07-24 |

golden fixtures（`tests/fixtures/match-predicate-golden/01〜09`）も同日、
`apps/backend/tests/fixtures/match-predicate-golden/` から逐語コピー。

## 再同期手順（運営 AI 向け）

1. upstream の該当ファイルと golden fixtures を取得する。
2. 3 ファイルと fixtures を丸ごと置き換える（部分マージ・手修正はしない）。
3. 本台帳の sha256・コピー日を更新する。
4. `tools/test-matcher-golden.sh` を実行し全 fixture green を確認する。
   red の場合は置き換えを取り消し、upstream 側の変更内容を確認してから再判断する。
5. 変更点が feed 契約（`docs/design/feed-contract-v1.md`）の sentinel 規約に影響する
   場合は、契約文書の改訂（v1 内の追記 or v2）とセットでのみ取り込む。
