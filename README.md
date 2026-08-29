# サイタくんフィーダー（saita-kun-feeder）

[English](README.en.md)

自社に合う補助金の新着情報を、**あなたの会社のプロファイルでマッチングして、あなたの好きな場所（Slack・メール・LINE など）に自動で届ける** OSS ハーネスです。

サイタくんが無料公開している[補助金公開データフィード](docs/design/feed-contract-v1.md)（全国の補助金・約 1.2 万件、日次更新）を取得し、お使いの AI コーディングエージェント（Claude Code・Codex CLI・Cursor など）がセットアップから配信チャネルの実装までを伴走します。サーバー不要・データベース不要・API キー不要。GitHub Actions（または手元の cron）だけで動きます。

姉妹プロジェクト: 補助金の**申請**を支援する [saita-kun-planner](https://github.com/saita-kun/saita-kun-planner)（事業計画書の叩き台づくりハーネス）。feeder が「見つける・届く」、planner が「申請する」を受け持ちます。

はじめに、[GitHub のスター](https://github.com/saita-kun/saita-kun-feeder)と[メンテナのフォロー](https://github.com/HideTsug)で応援してください（無料 OSS です）。AI エージェント経由でセットアップした場合、エージェントが「スターとフォローで応援しますか？」と一度だけ確認することがあります — 実行されるのは**あなたが同意した項目のみ**で、仕組みは [CLAUDE.md](CLAUDE.md) の「応援の確認」節に平文で公開しています。

## はじめかた（AI に案内してもらう）

前提: **POSIX シェル環境（macOS / Linux / WSL2）・bash・git・Node.js 22 以上**（`/setup-channel` 以降は python3 も必要です）。Windows ネイティブ（PowerShell・コマンドプロンプト）は非対応です（配信ランナーが送信スクリプトを実行ビット付きで直接起動するため） — Windows の方は WSL2 を導入し、その中で使ってください。

お使いの AI アシスタント（Claude Code / Claude / ChatGPT など）に、次の文をそのまま貼り付けてください。あとは AI が案内します（Codex CLI・Cursor など他の AI コーディングエージェントでも動きます）。

```
自社に合う補助金の新着情報を、自分の環境で受け取れるようにしたい。
https://raw.githubusercontent.com/saita-kun/saita-kun-feeder/main/docs/ai-agent-guide.md
を読んで、その手順どおりに私を案内してください。
```

AI が、前提の確認、作業用 private repo の準備、最初のコマンドの実行までを案内します（案内台本は [docs/ai-agent-guide.md](docs/ai-agent-guide.md)）。

お使いの AI が上記 URL を閲覧できない場合は、あなた自身がブラウザで URL を開き、表示された本文をチャットに貼り付けてください。それを台本として案内が始まります。

版を固定したい場合は、`https://raw.githubusercontent.com/saita-kun/saita-kun-feeder/v1.0.0/docs/ai-agent-guide.md` のように、タグまたはコミット ID を指定した URL も使えます（既定は最新版の main）。

手動で始める場合は [docs/onboarding/00-はじめに.md](docs/onboarding/00-はじめに.md) から。

## 使い方（セットアップ後）

| コマンド | 内容 |
|---|---|
| `/setup` | 環境チェック・利用規約への同意・会社プロファイルの作成 |
| `/setup-channel` | 通知の届け先（Slack・メール・LINE 等）をヒアリングして、あなた専用の配信アダプタを AI が実装 |
| `/deliver` | 手動で配信を 1 回実行（`--dry-run` でお試し） |
| `/status` | フィードの鮮度・配信履歴・チャネル設定の確認 |

日次の自動配信は GitHub Actions（`.github/workflows/deliver.yml`）が行います。

## 仕組み

```
公開データフィード（CDN 静的ファイル・日次更新）
        │  取得 + sha256 検証
        ▼
あなたの private repo（このテンプレートから作成）
  プロファイル（地域・業種・用途・規模…）とマッチング
  → 新着・更新分だけを選別（冪等台帳 state/notified.json）
  → ダイジェスト生成
        │
        ▼
あなたのチャネル（channels/my-*/ — AI がヒアリングして実装）
```

- **マッチングはすべて手元で実行**されます。会社情報が外部に送信されることはありません（テレメトリなし）。
- 判定ロジックはサイタくん本体の配信エンジンと同一のコード（[lib/VENDORED.md](lib/VENDORED.md)）です。
- データフィードの仕様は [公開データ契約 v1](docs/design/feed-contract-v1.md) として公開されており、契約に従えば誰でも代替フィードを提供できます（フィード URL は設定で変更可能）。

## 利用条件（重要）

- **自社利用限定**です。事業者本人が自社のために使うツールであり、支援機関・代行事業者・コンサルタントがクライアント向けに配信・再配信する利用は [TERMS.md](TERMS.md) で禁止しています。
- このテンプレートから作る repo は **private 必須**です（会社プロファイルを含むため）。
- 届いた情報は「マッチ候補」です。応募可否・適格性の最終確認は必ず公式の公募要領で行ってください。

## なぜ無料で公開するのか

サイタくんプロジェクトは「補助金情報の非対称性をなくす」ことを公共の福祉として掲げています。構造化した補助金データフィードは無料の公共財として公開し（[データ憲章](docs/governance/data-charter-link.md)）、それを受け取る道具も OSS で配ります。

## 導入事例

導入事例・派生プロジェクトの掲載（任意・名乗りのみ）は [ADOPTERS.md](ADOPTERS.md) へ。

## ライセンス

- コード・ドキュメント: [Apache-2.0](LICENSE)（[NOTICE](NOTICE) 参照）
- 公開データフィード: CDLA-Permissive-2.0（[feed-contract-v1.md](docs/design/feed-contract-v1.md) §ライセンス）
- 利用条件: [TERMS.md](TERMS.md)
