# SECURITY

脆弱性を発見した場合は、公開 Issue ではなく GitHub の **Private vulnerability reporting**（Security タブ → Report a vulnerability）で報告してください。

対象の例:

- チャネルアダプタ契約・ランナーにおける秘匿値の漏えい経路
- フィード検証（sha256・スキーマ）の迂回
- 生成アダプタを通じたコマンドインジェクション

利用者側の一般原則: 秘匿値は GitHub Actions Secrets / 環境変数のみに置き、ファイルにコミットしない（`docs/design/notifier-contract.md` §4）。誤ってコミットした場合は、履歴からの削除よりも**値の失効（ローテーション）を最優先**してください。
