# AGENTS.md

Claude Code 以外の AI エージェントがこのリポジトリを扱う場合の規範です。内容は `CLAUDE.md` と同一の前提に従ってください。

- 利用者支援の手順・ガードレール・setup ゲート: `CLAUDE.md`
- 設計不変条件: `docs/design/decisions/`（変更前に必読）
- 利用条件: `TERMS.md`（自社利用限定）
- 配信アダプタの実装契約: `docs/design/notifier-contract.md`
- データフィードの契約: `docs/design/feed-contract-v1.md`

slash command 相当の作業指示は `.claude/commands/*.md` に手順書として書かれています。コマンド実行環境がないエージェントは、該当ファイルを読み、手順書として順に実行してください。
