# repo-structure — コア層と育成層

saita-kun-feeder は planner と同じ「テンプレート repo」モデルで配布する。**repo = 利用単位（1 事業者）、公開データフィード = 配布単位（データ）、ダイジェスト = 生成物**。

## コア層（core-manifest.json の core_paths）

「どの会社でも同一であるべきもの」。上流（canonical repo）の更新で上書きされる前提のファイル群。

- ガバナンス: README / LICENSE / NOTICE / TERMS.md / CLAUDE.md / AGENTS.md / docs/
- 契約: `docs/design/feed-contract-v1.md`・`docs/design/notifier-contract.md`・`schemas/`
- ロジック: `lib/`（vendored 3 ファイル + feeder 層）・`runner/`・`channels/dryrun/`
- 検査: `tools/`・`tests/`・`.github/workflows/`
- コマンド: `.claude/commands/`

## 育成層（利用者所有 — 上流更新で触らない）

「その会社の事実・生成物」。

| パス | 内容 | git |
|---|---|---|
| `profile/delivery-profile.json` | 会社の要件プロファイル（属性のみ） | **コミットする**（GHA が読むため） |
| `state/notified.json` | 冪等台帳 | **コミットする**（実行間の永続 + 監査） |
| `state/cache/` | 直近正常フィードのキャッシュ | gitignore |
| `channels/my-*/` | AI 生成の配信アダプタ | コミットする（秘匿値は含めない契約） |
| `input/` | 同意記録（setup-state.json）等 | gitignore |
| `output/` | 生成ダイジェスト | gitignore |

## 秘匿値の置き場所

webhook URL・SMTP 認証情報・チャネルトークンは **GitHub Actions Secrets / ローカル環境変数のみ**。profile・channel.json・台帳には書かない（channel.json は必要な env 変数名を `requires_env` で宣言するだけ）。

## 単一公開 repo（planner との違い）

planner は internal→public の二層 + export ゲートだが、feeder は**単一公開 repo**とする。feeder には内部専用文書がなく（戦略文書は planner/親 repo 側にある）、export ゲートは同期ずれという故障モードを持ち込むだけで品質に寄与しないため。公開不可の情報が将来生まれた場合は、feeder に置かず親 repo 側に置く。
