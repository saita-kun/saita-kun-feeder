# CONTRIBUTING

改善提案・不具合報告は canonical repo（`saita-kun/saita-kun-feeder`）の Issue へお願いします。

- **変更前に必読**: `docs/design/decisions/`（設計不変条件）。これに反する PR は改善内容にかかわらず受け付けられません（例: チャネル実装の同梱、vendored ファイルの改変、スクレイパー追加）。
- CLA はありません。**DCO**（Developer Certificate of Origin）方式です。コミットに `Signed-off-by:` を付けてください（`git commit -s`）。
- コード変更には対応するテスト（`node --test`）と `tools/validate.sh` green を求めます。
- データ内容（補助金情報の誤り・抜け）はコードではなく producer 側の問題です。Issue に URL を添えて報告してください。
