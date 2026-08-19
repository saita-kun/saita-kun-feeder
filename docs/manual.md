# マニュアル

日常運用のリファレンスです。初回準備は `docs/onboarding/00-はじめに.md`、コマンドの詳細は `.claude/commands/` を参照。

## 全体像

```
公開データフィード（CDN・日次更新）
  → 取得 + sha256 検証（lib/feed-client.js。失敗時は state/cache/ で劣化継続）
  → open 判定 + プロファイルとマッチング（lib/match-user-subsidy.js — 本体配信エンジンと同一コード）
  → 台帳と突合して新着/更新だけ選別（state/notified.json、週15/日5 上限）
  → ダイジェスト生成（output/digest-<日付>-<チャネル>.md / .json）
  → チャネルアダプタが送信（channels/<name>/send）
```

## 日次自動配信（GitHub Actions）

`.github/workflows/deliver.yml` が毎日 22:00 UTC（JST 07:00）に実行します。

- 実行条件: repo が private・`profile/delivery-profile.json` がサンプルでない・TERMS 同意 sha が一致
- 実行後、台帳 `state/notified.json` の変更を bot が自動コミットします
- チャネルの秘匿値は repo の Secrets に置き、`deliver.yml` の `env:` で渡します（`/setup-channel` が案内）
- 手動発火: Actions タブから `Run workflow`（workflow_dispatch）
- 基準日はランナー内で UTC 日付として計算されます。既定の 22:00 UTC 実行は UTC ではまだ前日なので、JST 07:00 に届くダイジェストは **JST の前日**を基準日として作られます。日付を使う処理はすべてこの基準日を UTC 日付境界に丸めて計算するため、影響はダイジェストの見出しとファイル名（`digest-<日付>-<チャネル>`）だけでなく、締切の「残り◯日」・open 判定（`isOpen`）・締切余裕日数フィルタ（`deadline_buffer_days`）にも及びます。具体的には、JST ではすでに締切日を過ぎた案件が「残り 0 日」の open として残ります。**上限（既定 日 5 件・週 15 件）は締切の早い順に消費される**ため、この期限切れ案件が枠を取り、まだ有効な案件が翌日以降に繰り越されることがあります。台帳の記録時刻（`notified_at`）は実時刻なのでずれません
- 基準日を JST の当日に揃えたい場合は、`deliver.yml` の `cron` を **JST の日中**（目安 `0 1` 〜 `0 9` UTC = JST 10:00〜18:00）に置きます。UTC 日付と JST 日付が一致するのは 00:00〜14:59 UTC ですが、**GitHub Actions のスケジュール実行は指定時刻より遅れて始まることがある**ため、15:00 UTC 直前のような端の時刻は避けてください（数分の遅れで再び前日基準に戻り、上のずれが復活します）。例: JST 12:00 に受け取りたい → `0 3 * * *`

## 手元の定期実行で動かす（GitHub Actions を使わない場合）

ランナーは GitHub Actions への依存を持ちません。ゴールは **「1 日 1 回ランナーが実行され、実行できたことを翌朝確認できる状態」** です。手段は cron・systemd timer・launchd のどれでも構いません（それぞれ設定方法は環境の公式ドキュメントに従ってください）。cron を使う場合の要点は次の 2 つです。

**1. node の場所を cron に教える（`PATH` 行とランナーの絶対パスの両方）。** cron は最小の `PATH`（概ね `/usr/bin:/bin`）で起動するため、nvm・Homebrew・asdf・Volta で入れた node は解決されず、毎朝 `node: command not found` で黙って失敗します。対話シェルで `command -v node` を実行し、次の 2 つを**両方**行ってください。

- crontab の先頭に `PATH=` 行を置き、node のあるディレクトリ（`dirname "$(command -v node)"` の出力）を含める
- ランナー自体も絶対パスで起動する

`PATH=` 行を省略しないでください。チャネルアダプタ `channels/*/send` は `#!/usr/bin/env node` のような shebang でランナーから直接 exec されるため、`PATH` が通っていないとランナーが動いてもアダプタの起動で `env: node: No such file or directory` になり、配信だけが失敗します。

**2. 出力を捨てず、実行日時つきでログファイルへ落とす。ランナーの終了コードは捨てない。** 出力を `>/dev/null` に捨てると失敗の手がかりが消えます（旧記載の `... git commit -m "..." >/dev/null` はシェルの解析上 `git commit` にだけ結合し、node の出力は cron のローカルメールへ行くため、どちらも利用者の目には触れません）。ランナーの出力には日時が入らないので、各実行の先頭に**ローカル時刻**を出しておくと「今朝ちゃんと起動したか」をログ末尾で判別できます（`date -u` は JST 早朝実行だと前日の日付を出してしまうので使いません。crontab のコマンド欄では `%` を `\%` とエスケープする必要があります）。台帳のコミットは行いつつ、cron ジョブ自体はランナーの終了コード（2 = 一部送信失敗）を返すようにします。

```bash
# 毎朝 7 時に実行する例（crontab -e）
# PATH の先頭と node の絶対パスは `command -v node` の実際の値に置き換える
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin

0 7 * * * cd /path/to/your-feeder && { date +\%FT\%T\%z; /opt/homebrew/bin/node runner/deliver.js; code=$?; git add state/notified.json && git commit -m "chore: update delivery ledger"; exit $code; } >> /path/to/your-feeder/cron-deliver.log 2>&1
```

到達確認（翌朝これを見る）:

- **主条件**: `cron-deliver.log` の末尾に**当日（ローカル日付）の日時行**があり、その直後に `feed: N 件（...）/ open: ... / マッチ: M 件` が続いて `command not found` 等で終わっていないこと。日時行が無ければ cron 自体が起動していません（ログは前日のまま残るので、末尾に行があること自体を成功と読まないでください）
- **送信結果まで見る**: `feed:` の行はアダプタを起動する前に出るので、この行だけでは配信成功を意味しません。同じ実行のブロックに `[<チャネル>] 送信失敗: ...` が無いことまで確認します（失敗した場合は台帳に `failed` が記録され、30 分後以降の実行で最大 3 回まで自動再送されます）
- **配信対象があった日のみ**: `output/` にダイジェスト（`digest-<日付>-<チャネル>.md`）が増えていること。ファイル名の日付は**基準日（UTC 日付）**なので、JST 早朝に実行する上の例では **JST の前日**の日付が付きます（当日日付のファイルを探さないでください）。新着・更新がなくフィード警告も無い日は、`[<チャネル>] 新着・更新なし — 配信しません` と出してダイジェストを作らないのが正常な動作です。`output/` が増えないこと自体を失敗と判定しないでください（判定はログで行います）

チャネルの環境変数は cron 環境に設定してください。ログファイルは repo 直下に置くなら `.gitignore` に追加してください。

## ランナーの引数

```bash
node runner/deliver.js [--dry-run] [--today YYYY-MM-DD] [--feed <url|dir>] \
                       [--profile <path>] [--ledger <path>] [--out <dir>]
```

- `--dry-run`: 台帳を変更せず、アダプタも副作用なしモード（`SAITA_FEEDER_DRY_RUN=1`）で起動
- `--today`: 基準日を固定（テスト・検証用）
- exit code: 0 = 正常 / 1 = 致命的エラー / 2 = 一部送信失敗（台帳に failed 記録、30 分後以降の実行で最大 3 回再送）

## プロファイルの調整

`profile/delivery-profile.json` を編集し、`tools/check-profile.sh` で検証します。絞り込み軸の意味（NULL = 制約なし・部分一致 = いずれか一致）は `schemas/delivery-profile.schema.json` の説明を参照。編集後はコミットを忘れずに（GitHub Actions が読むため）。

## 上流更新の取り込み（ハーネスの育て方）

コア層（`core-manifest.json` の `core_paths`）は上流テンプレートの改善で更新されることがあります。取り込みは `tools/update-core.sh` を実行し、育成層（profile / state / channels/my-* / input / output）が触られていないことを diff で確認してからコミットします。

## トラブルシュート

| 症状 | 見る場所 |
|---|---|
| 配信が来ない | `/status` → フィード鮮度・台帳・Actions 直近実行 |
| 「同意記録が一致しません」 | TERMS.md が更新されています。`/setup` で再同意 |
| 警告: キャッシュで継続 | フィード取得失敗。一時的なら次回自動回復。継続するなら `/status` で鮮度確認 |
| 送信失敗（exit 2） | チャネルの Secrets 設定・`tools/check-channels.sh`。台帳が自動で最大 3 回再送 |
| マッチが多すぎ/少なすぎ | プロファイルの categories / purposes / 金額レンジを調整 |
