# CONTRIBUTING

改善提案・不具合報告は canonical repo（`saita-kun/saita-kun-feeder`）の Issue へお願いします。

- **変更前に必読**: `docs/design/decisions/`（設計不変条件）。これに反する PR は改善内容にかかわらず受け付けられません（例: チャネル実装の同梱、vendored ファイルの改変、スクレイパー追加）。
- CLA はありません。**DCO**（Developer Certificate of Origin）方式です。コミットに `Signed-off-by:` を付けてください（`git commit -s`）。
- コード変更には対応するテスト（`node --test`）と `tools/validate.sh` green を求めます。
- データ内容（補助金情報の誤り・抜け）はコードではなく producer 側の問題です。Issue に URL を添えて報告してください。

## ローカル検証の準備

Node 22・bash・python3 に加え、workflow の静的検証には **actionlint 1.7.12** が必要です。macOS / Linux の x64・ARM64 向けに、固定版と配布物の SHA-256 を検証するインストーラを用意しています（curl・tar が必要）。インストール時のみダウンロードし、検証・テスト中はダウンロードしません。

```bash
bash tools/install-actionlint.sh "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"
actionlint -version
bash tools/check-workflows.sh
bash tools/validate.sh
node --test tests/*.test.js
```

インストール先は第1引数で変更できます。そのディレクトリを `PATH` に追加してください。CLI 不足・版不一致・workflow の YAML / Actions 構造の不備は品質ゲートを失敗させます。検査は `-shellcheck= -pyflakes=` を明示し、追加の解析ツールを要求しません。Secret の登録・`env` の実行時解決・通知の実到達は別に確認します。
