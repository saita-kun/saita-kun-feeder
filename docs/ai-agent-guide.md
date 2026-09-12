---
audience: ai
guide_version: 1.0.0
updated_at: 2026-09-12
canonical: https://raw.githubusercontent.com/saita-kun/saita-kun-feeder/main/docs/ai-agent-guide.md
---

# AI エージェント向けガイド（ai-agent-guide）

このファイルは、**repo の外にいる AI**が、利用者を「配信が届くところ」まで案内するための台本です。URL からの初回案内にも、既存 repo での再開にも使います。あなたがこのファイルを読まされた AI なら、以下の手順で利用者を案内してください。

## 読んでいる版の確認

- `guide_version` はガイドの版、`updated_at` はその更新日です。`canonical` は内容が更新される main への入口です。
- 版固定 URL: `https://raw.githubusercontent.com/saita-kun/saita-kun-feeder/<tag-or-sha>/docs/ai-agent-guide.md`。`<tag-or-sha>` を参照したい実在の tag または commit SHA に置き換えます。
- 案内開始時に参照 URL と版ヘッダーを確認します。clone 済みなら repo ルートで `git rev-parse HEAD` とローカルの版ヘッダーも確認し、**clone 済みの版を優先**します。ヘッダーがない旧版は commit SHA で識別します。
- URL で読んだ版とローカルの版が違っても、手順を混ぜません。ガイドの自動取得や、版を合わせるための自動 pull・更新は行いません。

## あなたが案内する相手

自社に合う補助金の新着情報を自動で受け取りたい**事業者本人**です。エンジニアではない可能性が高い前提で、専門用語を避け、1 ステップずつ進めてください。

最初に 1 つだけ確認します: 「この仕組みは、ご自身の会社のために使いますか？」— 支援機関・代行業者としてクライアント向けに使う場合は利用条件（TERMS 第 2 条・自社利用限定）により利用できないことを伝え、ここで終了します。

## S0. 前提の確認

1. GitHub アカウントを持っているか（なければ `docs/onboarding/01-githubアカウント作成.md` 相当: github.com で無料登録）
2. repo を開いて作業できる **AI コーディングエージェント**が手元にあるか。特定の製品は要求しません（Claude Code・Codex CLI・Cursor・Gemini CLI など、ローカルのファイルを読み書きしてコマンドを実行できるものであれば動きます）。まだ何も無い場合の代表例として Claude Code を案内できます（`docs/onboarding/02-claude-codeセットアップ.md` 相当: claude.com/claude-code の公式手順）。
3. OS の前提: POSIX シェル環境（macOS / Linux / WSL2）。Windows ネイティブは非対応なので、Windows の利用者には WSL2 を導入し、その中で clone して作業してもらいます。

続けて、現在の AI の実行能力を判定します。製品名だけでは決めません。

| モード | 条件と進め方 |
|---|---|
| 操作モード | 対象パスの読み書きとコマンド実行の両方ができる場合。AI が合意した範囲の操作を実行し、結果を確認します。 |
| 代読モード | 書込またはコマンド実行ができない場合（能力が未確認の場合も含む）。利用者に手順を 1 つずつ案内し、実行結果を受け取って確認します。未実行の操作を実行済みと報告しません。 |

- 保存先は利用者の**指定済みパスを優先**します。**未指定の場合**は保存先の絶対パスを利用者に確認し、確定するまで作成・clone しません。カレントディレクトリを暗黙の保存先にしません。
- **repo 作成・clone の前に明示同意**を得ます。対象（所有者・repo 名・Private）と保存先を提示し、合意済みの範囲は引き継ぎます。返答が曖昧・未回答なら実行しません。
- 既存の保存先は `git -C "<保存先>" rev-parse --show-toplevel` と `git -C "<保存先>" remote get-url origin` で、repo ルートと利用者の対象 repo を確認します。親ディレクトリの別 repo を clone 済みと誤認しません。空でない非 repo・判定不能な保存先も停止し、既存ファイルを上書き・削除しません。

### 既存状態からの再開

保存先の確認を先に行い、対象 repo が確認できてから setup を判定します。代読時も利用者の実行結果で確認し、未確認の条件を成立扱いしません。

| 分岐 | 次の手順 |
|---|---|
| 保存先が別repo: 停止 | 作成・clone・setup を行わず、利用者に保存先を確認し直します。 |
| clone済み: S1をスキップ | 対象 repo を再利用し、ローカルの `CLAUDE.md` / `AGENTS.md` を読んで setup の状態を確認します。再 clone しません。 |
| setup有効: S2をスキップ | 下表の 8 条件すべて（S3 前の環境ゲートを含む）を満たしてから S3 へ進みます。 |
| setup不完全: S2へ | 未完了の項目を `.claude/commands/setup.md` に従って再開します。 |

次の **8 条件がすべて確認できた場合だけ setup有効**です。いずれかが不成立または未確認なら setup不完全とします。検証コマンドは対象 repo のルートで再開時に実行し、終了コードと出力を確認します。

| 条件 | 確認内容（すべて対象 repo の現行状態で照合） | 検証コマンド |
|---|---|---|
| 1 | `input/setup-state.json` が存在し、JSON として読める（exit 0）。 | `node -e 'JSON.parse(require("fs").readFileSync("input/setup-state.json","utf8"))'` |
| 2 | `terms_sha256` / `data_policy_sha256` が、それぞれ現行 `TERMS.md` / `docs/data-policy.md` のバイト列の sha256（hex 64 桁）と一致する（exit 0）。 | `node -e 'const f=require("fs"),c=require("crypto"),a=require("assert/strict"),s=JSON.parse(f.readFileSync("input/setup-state.json","utf8"));for(const [k,p] of [["terms_sha256","TERMS.md"],["data_policy_sha256","docs/data-policy.md"]])a.equal(s[k],c.createHash("sha256").update(f.readFileSync(p)).digest("hex"))'` |
| 3 | 実プロファイル `profile/delivery-profile.json` が存在し、`bash tools/check-profile.sh` が成功（exit 0）する。sample だけでの成功は不可。 | `test -f profile/delivery-profile.json && bash tools/check-profile.sh` |
| 4 | 実プロファイルを読んだ `profile.terms_accepted_sha256` が、現行 `TERMS.md` のバイト列の sha256 と一致する（exit 0）。 | `node -e 'const f=require("fs"),c=require("crypto"),a=require("assert/strict"),profile=JSON.parse(f.readFileSync("profile/delivery-profile.json","utf8"));a.equal(profile.terms_accepted_sha256,c.createHash("sha256").update(f.readFileSync("TERMS.md")).digest("hex"))'` |
| 5 | python3 の導入を確認する（exit 0）。 | `python3 --version` |
| 6 | 全体検証が成功（exit 0・`validate: OK`）する。 | `bash tools/validate.sh` |
| 7 | 実プロファイルの `feed_base_url` を使う dry-run が完走（exit 0）し、ログが `feed: ...（network）` を示す。`（cache）` での継続や `--feed` による fixture への差し替えは不可。 | `node runner/deliver.js --profile profile/delivery-profile.json --dry-run` |
| 8 | 現在の `origin` が private であることを再開時に確認する（exit 0・`true`）。`CLAUDE.md` の private 確認を S2 省略時も維持する。 | `gh repo view --json isPrivate --jq .isPrivate "$(git remote get-url origin)"`。gh が使えない場合は、同じ origin repo の Settings で Visibility が Private と表示されていることを利用者に確認してもらう。 |

private 確認が `false`（public）または未確認なら setup不完全とし、S2 の `.claude/commands/setup.md` 手順 1 に戻ります。現在の origin が private だと確認できるまで S3・配信・push へ進みません。過去の setup 時の確認や API の `404` は代用しません。

`support_prompt` だけの記録は setup 完了扱いにしないでください。ハッシュの算出・照合は `.claude/commands/setup.md` の手順に従います。dry-run の成功だけでは条件 1・2 を確認できません。

dry-run が失敗または未確認の場合や、キャッシュで継続しただけの場合は、S2 の `.claude/commands/setup.md` 手順 5「お試し実行への案内」へ戻り、原因を解消して条件 7 を再実行します。`bash tools/validate.sh` や fixture の送信テストの成功では代用しません。

**S3 前の環境ゲート（新規・再開共通）**: S2 を省略する場合も、`.claude/commands/setup.md` の移行条件に従い、条件 5・6 を満たしてから S3 へ進みます。python3 未導入なら先に導入を案内し、検証が失敗または未確認なら S3 へ進まず原因を解消します。python3 未導入でも S2 のプロファイル作成と dry-run は進められます。

## S1. テンプレートから private repo を作る

自分の private repo が作成済みで未 clone なら、手順 1〜3 を飛ばして手順 4 へ進みます。

1. ブラウザで `https://github.com/saita-kun/saita-kun-feeder` を開く
2. 「Use this template」→「Create a new repository」
3. **Visibility は必ず Private** を選ぶ（会社プロファイルを置くため。public では利用不可）
4. 自分のアカウントの private repo URL と、合意した保存先を使って clone する。保存先は未作成または空ディレクトリであることを確認し、下記のプレースホルダを置き換えてから実行する（代読時は利用者が実行）。テンプレート本体を直接 clone しない。

```bash
FEEDER_REPO_URL="<利用者の private repo URL>"
FEEDER_DEST_DIR="<合意した保存先の絶対パス>"
git clone -- "$FEEDER_REPO_URL" "$FEEDER_DEST_DIR"
cd -- "$FEEDER_DEST_DIR"
```

clone の成功と作業ディレクトリを確認してから、ローカルの版と S0 の再開条件を確認します。

## S2. AI エージェントで開いて /setup

対象 repo を、利用者が使っている AI コーディングエージェントで開き、セットアップ手順を開始・再開します。以降は repo 内の `CLAUDE.md` / `AGENTS.md` と `.claude/commands/` が案内を引き継ぎます。新規時も再開時も `.claude/commands/setup.md` に従い、未完了の項目だけ進めます。

開始のしかたは環境によって 2 通りあります:

- **slash command が使える環境**（代表例: Claude Code）: `/setup` と入力してもらう。
- **slash command 機構が無い環境**（Codex CLI・Cursor など）: `AGENTS.md` に書かれているとおり、`.claude/commands/*.md` を手順書として読ませます。利用者には「`.claude/commands/setup.md` を読んで、手順どおりに進めてください」と依頼してもらえば同じ結果になります（以降 `/setup-channel`・`/deliver`・`/status` も同じ読み替えです）。

`/setup` が行うこと（利用者への予告用）:
- 環境チェック（bash / python3 / node）と private 確認
- 利用規約（TERMS.md）の確認と同意
- 会社プロファイルの聞き取り（所在地・業種・用途・従業員数）
- お試し実行（dry-run）でダイジェストの確認

## S3. 配信チャネルと自動化

`/setup-channel`（`.claude/commands/setup-channel.md`）で通知の届け先（Slack・メール等）を設定します。実送信テストは `/setup-channel` の「利用者の確認を取ってから 1 回だけ」に揃えます。

| 配信方法・確認状況 | 次の手順 |
|---|---|
| GitHub Actions: 確認済み | 手順 6 の Deliver ログに `[my-<name>] 送信成功` が出て、利用者による受信確認が済んだ場合、追加のローカル実配信を省きます。Actions が更新した `state/notified.json` が手元に未反映なら、同じ新着を再送するためです。 |
| GitHub Actions: 未確認 | 手順 6 に従って確認を続けます。スキップ・新着なしで緑になっただけでは確認済みとしません。新着なしの場合は翌日以降の実行ログと受信で確認し、ローカル実配信で代替しません。 |
| 手元での実行だけで運用 | 手順 4-3 の実送信テストを利用者の確認後に 1 回だけ行い、確認済みなら繰り返しません。 |

手動配信は `/deliver`（`.claude/commands/deliver.md`）に従います。初回案内で追加のお試しが必要な場合は `--dry-run` のみ使います。

GitHub Actions（repo 同梱の `deliver.yml`）が毎日自動で配信します。

## 守ること

- 利用条件の正本は repo 内 `TERMS.md`。特に自社利用限定・private 必須。
- 届く情報は「マッチ候補」であり、応募判断は公式の公募要領で行う旨を必ず伝える。
- このガイドと repo 内ドキュメントが食い違う場合は repo 内（clone 済みの版）を優先する。
