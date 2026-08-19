# AI エージェント向けガイド（ai-agent-guide）

このファイルは、**repo の外にいる AI**（利用者がまだ clone していない状態で、URL 貼り付けにより読まれる想定）が、利用者を「配信が届くところ」まで案内するための台本です。あなたがこのファイルを読まされた AI なら、以下の手順で利用者を案内してください。

## あなたが案内する相手

自社に合う補助金の新着情報を自動で受け取りたい**事業者本人**です。エンジニアではない可能性が高い前提で、専門用語を避け、1 ステップずつ進めてください。

最初に 1 つだけ確認します: 「この仕組みは、ご自身の会社のために使いますか？」— 支援機関・代行業者としてクライアント向けに使う場合は利用条件（TERMS 第 2 条・自社利用限定）により利用できないことを伝え、ここで終了します。

## S0. 前提の確認

1. GitHub アカウントを持っているか（なければ `docs/onboarding/01-githubアカウント作成.md` 相当: github.com で無料登録）
2. repo を開いて作業できる **AI コーディングエージェント**が手元にあるか。特定の製品は要求しません（Claude Code・Codex CLI・Cursor・Gemini CLI など、ローカルのファイルを読み書きしてコマンドを実行できるものであれば動きます）。まだ何も無い場合の代表例として Claude Code を案内できます（`docs/onboarding/02-claude-codeセットアップ.md` 相当: claude.com/claude-code の公式手順）。
3. OS の前提: POSIX シェル環境（macOS / Linux / WSL2）。Windows ネイティブは非対応なので、Windows の利用者には WSL2 を導入し、その中で clone して作業してもらいます。

## S1. テンプレートから private repo を作る

1. ブラウザで `https://github.com/saita-kun/saita-kun-feeder` を開く
2. 「Use this template」→「Create a new repository」
3. **Visibility は必ず Private** を選ぶ（会社プロファイルを置くため。public では利用不可）
4. 自分のアカウントに repo を作成し、手元に clone する

## S2. AI エージェントで開いて /setup

作成した repo を、利用者が使っている AI コーディングエージェントで開いてもらい、セットアップ手順を開始するよう案内します。以降は repo 内の `CLAUDE.md` / `AGENTS.md` と `.claude/commands/` が案内を引き継ぎます（あなたの役目はここまでです）。

開始のしかたは環境によって 2 通りあります:

- **slash command が使える環境**（代表例: Claude Code）: `/setup` と入力してもらう。
- **slash command 機構が無い環境**（Codex CLI・Cursor など）: `AGENTS.md` に書かれているとおり、`.claude/commands/*.md` を手順書として読ませます。利用者には「`.claude/commands/setup.md` を読んで、手順どおりに進めてください」と依頼してもらえば同じ結果になります（以降 `/setup-channel`・`/deliver`・`/status` も同じ読み替えです）。

`/setup` が行うこと（利用者への予告用）:
- 環境チェック（bash / python3 / node）と private 確認
- 利用規約（TERMS.md）の確認と同意
- 会社プロファイルの聞き取り（所在地・業種・用途・従業員数）
- お試し実行（dry-run）でダイジェストの確認

## S3. 配信チャネルと自動化

- `/setup-channel` で通知の届け先（Slack・メール等）を設定
- GitHub Actions（repo 同梱の `deliver.yml`）が毎日自動で配信

## 守ること

- 利用条件の正本は repo 内 `TERMS.md`。特に自社利用限定・private 必須。
- 届く情報は「マッチ候補」であり、応募判断は公式の公募要領で行う旨を必ず伝える。
- このガイドと repo 内ドキュメントが食い違う場合は repo 内（clone 済みの版）を優先する。
