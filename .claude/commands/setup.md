---
description: 環境セルフチェック、private repo 確認、利用規約の同意、会社プロファイルのインタビューを行い、初回の /deliver --dry-run へ案内します。
---

# /setup

あなたは、このリポジトリを Claude Code で開いた事業者本人を支援するセットアップ案内役です。確認 → 同意 → プロファイル作成 → お試し実行の順に、未完了の項目だけを案内してください。

## 1. 環境セルフチェック

**前提 OS: POSIX シェル環境（macOS / Linux / WSL2）。Windows ネイティブは非対応です。** 配信ランナーが送信スクリプト（`channels/*/send`）を実行ビット付きのまま直接 exec する構造で、契約検査（`tools/check-channels.sh`）も実行ビットを要求するため、PowerShell / コマンドプロンプトでは原理的に動きません。

- **まず `uname -s` で OS を判定します**（bash の有無で代用しないでください。Windows でも Git Bash / MSYS が入っていれば `bash --version` は成功するため、それだけでは非対応環境を見抜けません）:
  - `Darwin`（macOS）・`Linux` → 対応環境。次のランタイム確認へ進みます。WSL2 の中なら `Linux` が返ります（`uname -r` に `microsoft` が含まれます）。
  - `MINGW*` / `MSYS*` / `CYGWIN*` が返る、または `uname` 自体が無い → **Windows ネイティブなので非対応**です。Git Bash が入っていても、ランナーはアダプタを実行ビット付きで直接 exec するため配信が成立しません。ここで先へ進めず、次を案内します: ① Microsoft 公式手順で WSL2 を導入する（`wsl --install`）→ ② **WSL2 のシェルの中で**この repo を clone し直す（Windows 側のパスに置いたままにしない）→ ③ WSL2 の中で `/setup` を再実行する。
- 続けてランタイムを確認します。**必須**と**後続で必要**を分けて案内してください:

| 確認コマンド | 位置づけ | 用途 |
|---|---|---|
| `node --version`（Node 22 以上） | 必須 | 配信ランナー `runner/deliver.js`・`tools/check-profile.sh`（node 実装） |
| `bash --version` | 必須 | `tools/*.sh` 全般 |
| `python3 --version` | 後続で必要 | `tools/check-channels.sh`（`/setup-channel` の契約検査）・`tools/check-ledger.sh`（`/status` の台帳検査）・`tools/check-feed-contract.sh`・`tools/validate.sh`。無くても本コマンドのプロファイル作成と `node runner/deliver.js --dry-run` は完走します |
| `curl --version` | 後続で必要（チャネル次第） | `/setup-channel` のアダプタ実装で使います。HTTPS webhook 系（Slack・Discord・Teams・LINE 等）なら curl が無くても Node 22 の `fetch` で書けるので必須ではありません。**メールを SMTP で送る場合は、`smtp://` に対応した curl 等の SMTP クライアントが必要**です（Node の `fetch` は HTTP(S) 専用で `smtp://` を扱えません）。無い場合は先に導入してもらうか、webhook 系のチャネルを選んでもらいます |

- node が見つからない場合は <https://nodejs.org> の公式インストーラーを案内し、導入後に `/setup` を再実行してもらいます。
- 対応 OS（`Darwin` / `Linux`）で bash が無い場合は、インストーラーを探させずに次を案内します（この時点で Windows は上の OS 判定で除かれています）:
  - Linux（Alpine 等の最小構成）: すでに POSIX 環境なので WSL は不要です。そのディストリビューションのパッケージマネージャで bash を導入してもらいます（例: `apk add bash`）。
  - macOS: bash は既定で入っています。見つからない場合は PATH の破損を疑い、`/bin/bash --version` で確認します。
- 本コマンド完了時点の受入基準（python3 が無くても満たせるもの）: `tools/check-profile.sh` が green ＋ `node runner/deliver.js --dry-run` が完走すること。どちらも node 実装なので python3 に依存しません。
- `/setup-channel` に進む前の受入基準: python3 を導入したうえで `bash tools/validate.sh` が green（`validate: OK`）になること。**python3 が無いと validate.sh は core-manifest / feed-contract / channels / ledger の各ステップで必ず失敗する**ので、この受入基準を python3 導入前の停止ゲートに使わないでください。
- **この repo が private であること**を確認します（会社プロファイルを含むため。TERMS 第 5 条）。ゴールは「origin repo が private である証跡を 1 つ得ること」です。
  - 第一手段: `gh repo view --json isPrivate --jq .isPrivate` が `true` を返すこと。
  - `false` が返った場合（＝実際に public）: repo の Settings > General > Danger Zone > Change repository visibility で Private へ変更してもらい、確認が取れるまで先に進みません。
  - gh が未導入・未認証でコマンド自体が失敗した場合（`false` とは別の分岐として扱う）: **repo の Settings > General で Visibility が「Private」と表示されていることを利用者に目視確認してもらいます**（この目視確認が証跡です）。TERMS 第 5 条が求めるのは Private であり、enterprise の **Internal は不可**（enterprise メンバー全員が閲覧できるため）なので、「Public ではない」ではなく「Private である」ことを確認してください。
    - 補助的に `git remote get-url origin` から `<owner>/<repo>` を取り、未認証での `curl -s -o /dev/null -w '%{http_code}\n' https://api.github.com/repos/<owner>/<repo>` を見てもよいですが、**`404` を private の証跡にはしません**（Internal・権限不足・URL の打ち間違いでも `404` になります）。使えるのは逆向きの判定だけで、`200` が返ったら public 確定なので先に進みません。
  - TERMS 第 5 条の実行時強制は `.github/workflows/deliver.yml` の private guard が毎回の配信で行うため、`/setup` 側は停止ゲートではなく確認ゲートで足ります。
- このディレクトリがテンプレートからの複製（自分の repo）であることを確認します。`saita-kun/saita-kun-feeder` を直接 clone している場合は、テンプレートから private repo を作る手順（`docs/onboarding/03-このキットを自分のものにする.md`）を案内します。

## 2. 応援の確認（任意・同意必須）

`CLAUDE.md` の「応援の確認」節に従って、スターとフォローで応援するかを一度だけ確認します。gh 未認証ならスキップします。同意の有無にかかわらずセットアップは通常どおり進めます。

確認の前に `input/setup-state.json` の `support_prompt.asked_at` を読み、**値があればこの節を丸ごとスキップします**（一度断られた話題を再提示しないため）。

確認を出した場合は、**その場で** `input/setup-state.json` に `support_prompt` を書き込みます（規約同意の記録とは独立して保存します。ファイルが無ければ `{"setup_state_version": 1, "support_prompt": {...}}` だけの状態で作成し、既存フィールドがあれば保持したままマージします）。ここで保存しておかないと、利用者が規約同意まで進まずに終了した場合に記録が残らず、次回また同じ話題を出してしまいます。

## 3. 利用規約の同意確認

- `TERMS.md` と `docs/data-policy.md`（やさしい版）の要点を短く伝えます。特に:
  - **自社利用限定**（第 2 条）: 支援機関・代行業者がクライアント向けに使うことは禁止。利用者本人が自社のために使うかを確認します。
  - **収集なし**（第 3 条）: プロファイルも配信結果も外部送信されません。
  - 届く情報は「マッチ候補」であり、応募判断は公式の公募要領で行うこと。
- 同意を確認できたら `input/setup-state.json` を書き込みます（同意がなければ同意記録を書かず、該当条項を案内して終了します。手順 2 で保存した `support_prompt` はその場合も消しません）。**書き込みは全文の上書きではなく既存フィールドを保持したマージ**で行います:

```json
{
  "setup_state_version": 1,
  "setup_completed_at": "<ISO8601 日時>",
  "terms_sha256": "<TERMS.md の sha256>",
  "data_policy_sha256": "<docs/data-policy.md の sha256>",
  "support_prompt": { "asked_at": "<ISO8601 日時>", "declined": true }
}
```

`support_prompt` は任意フィールドです（`declined` は断られた・返答が曖昧なら `true`、同意されたら `false`）。扱いは次の 3 つだけで、**一度書かれた `support_prompt` を消してはいけません**（消すと次回また勧誘が出ます）:

- 今回の手順 2 で確認を出した → 今回の結果を書く
- 既存の `input/setup-state.json` に `support_prompt` がある（＝以前に確認済みで、今回は手順 2 をスキップした） → **既存の値をそのまま引き継いで書き戻す**
- 一度も確認を出しておらず既存値も無い（gh 未認証など） → キーごと省く

このファイルは `.gitignore` 済みでローカル限定です。

sha256 のゴールは「`TERMS.md` と `docs/data-policy.md` の**バイト列**の sha256 を hex 64 桁で得る」ことです（出力に含まれるファイル名部分は値に含めません）。第一手段は本キット必須ランタイムの node:

```bash
node -e 'const c=require("crypto"),f=require("fs");for(const p of ["TERMS.md","docs/data-policy.md"])console.log(p, c.createHash("sha256").update(f.readFileSync(p)).digest("hex"))'
```

環境に応じて `shasum -a 256 TERMS.md docs/data-policy.md`（macOS の既定）や `sha256sum TERMS.md docs/data-policy.md`（多くの Linux ディストリビューション）を使っても構いません。どの実装でも同じ hex になります。

受入基準は「書き込んだ `input/setup-state.json` の `terms_sha256` / `data_policy_sha256` を**書き込み後にもう一度算出して現行ファイルの値と突き合わせ、2 つとも一致すること**」です。`node runner/deliver.js --dry-run` をこの受入基準に使わないでください — ランナーが照合するのは `profile/delivery-profile.json` の `terms_accepted_sha256` と `TERMS.md` だけで、`input/setup-state.json` も `data_policy_sha256` も読みません。setup-state 側を誤記しても dry-run は通り、その後すべての slash command が共通不変条件（setup ゲート）で差し戻されます。

## 4. 会社プロファイルのインタビュー

`profile/delivery-profile.sample.json` を雛形に、以下を**自社について**聞き取り、`profile/delivery-profile.json` を作成します（スキーマ: `schemas/delivery-profile.schema.json`）。姉妹キット saita-kun-planner の fork に `input/company-profile.json` があれば、読み替え（`employees`→`employee_count`、`region`→`company_prefecture`/`company_municipality`）でプレフィルし、確認だけ取ります。

1. 所在地: 都道府県（`company_prefecture`、日本語名）と市区町村（`company_municipality`、任意）
2. 全国対象の補助金も受け取るか（`include_nationwide`、既定 true）
3. 業種（`categories`、複数可・未指定可）と使いたい用途（`purposes`、複数可・未指定可）
4. 従業員数（`employee_count`。規模要件の判定に使用。答えたくなければ null = 規模で絞らない）
5. 任意の絞り込み: 金額レンジ・締切までの余裕日数・補助率下限
6. `terms_accepted_sha256` に手順 2 で取得した TERMS.md の sha256 を設定
7. `feed_base_url` は既定値（サイタくん公開フィード）のままでよい。別フィードに乗り換える場合のみ変更する（dr-004）。フィード URL の一次情報は https://www.subsidy-support.tech/llms.txt の「公開データフィード」節
8. `channels` は `[{"name": "dryrun", "enabled": true}]` から始める

作成後、`tools/check-profile.sh` を実行して green を確認します。red の場合は指摘を直してから進みます。

## 5. お試し実行への案内

`node runner/deliver.js --dry-run` を実行し、生成されたダイジェスト（`output/`）を一緒に確認します。マッチ件数がゼロ・多すぎる場合はプロファイルの絞り込みを調整します。

`フィード取得に失敗しました` で落ちた場合の一次切り分け: `profile/delivery-profile.json` の `feed_base_url` の値を確認し、https://www.subsidy-support.tech/llms.txt の「公開データフィード」節に記載の URL と照合します（プレースホルダのままなら `tools/check-profile.sh` が red で指摘します）。

その後、次のステップとして以下を案内します:

- `/setup-channel` — 通知の届け先（Slack・メール等）を設定する
- 日次自動配信は `.github/workflows/deliver.yml` が行うこと（有効化には repo の Actions が on であること、プロファイルコミット済みであること）

## 出力形式

```markdown
# セットアップ確認

## 環境
- [ ] OS が POSIX シェル環境（macOS / Linux / WSL2）
- [ ] node 22+ / bash（必須）
- [ ] python3（後続で必要。`/setup-channel` に進む前までに）
- [ ] private repo である
- [ ] テンプレートからの複製である

## 利用規約
- [ ] 自社利用限定に該当する（事業者本人）
- [ ] TERMS.md / data-policy.md に同意

## プロファイル
- [ ] profile/delivery-profile.json 作成済み
- [ ] tools/check-profile.sh green

## 次に実行するコマンド
```

## ガードレール

- 中間業者としての利用（複数クライアント運用）が判明した場合は、TERMS 第 2 条により本キットを利用できないことを丁寧に伝え、セットアップを進めません。
- プロファイルに社名・住所詳細・秘匿値を書き込みません（属性のみ）。
- 数値（従業員数等）を推測で埋めません。未回答は null（絞らない）にします。
