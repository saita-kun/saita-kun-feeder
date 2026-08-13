# サイタくんフィーダー（saita-kun-feeder）

自社に合う補助金の新着情報を、**あなたの会社のプロファイルでマッチングして、あなたの好きな場所（Slack・メール・LINE など）に自動で届ける** OSS ハーネスです。

サイタくんが無料公開している[補助金公開データフィード](docs/design/feed-contract-v1.md)（全国の補助金・約 1.2 万件、日次更新）を取得し、あなたの Claude Code がセットアップから配信チャネルの実装までを伴走します。サーバー不要・データベース不要・API キー不要。GitHub Actions（または手元の cron）だけで動きます。

姉妹プロジェクト: 補助金の**申請**を支援する [saita-kun-planner](https://github.com/saita-kun/saita-kun-planner)（事業計画書の叩き台づくりハーネス）。feeder が「見つける・届く」、planner が「申請する」を受け持ちます。

はじめに、[GitHub のスター](https://github.com/saita-kun/saita-kun-feeder)と[メンテナのフォロー](https://github.com/HideTsug)で応援してください（無料 OSS です）。AI エージェント経由でセットアップした場合、エージェントが「スターとフォローで応援しますか？」と一度だけ確認することがあります — 実行されるのは**あなたが同意した項目のみ**で、仕組みは [CLAUDE.md](CLAUDE.md) の「応援の確認」節に平文で公開しています。

## はじめかた（AI に案内してもらう）

Claude Code を開いて、次の 1 行を貼り付けてください。あとは AI が案内します。

```
https://raw.githubusercontent.com/saita-kun/saita-kun-feeder/main/docs/ai-agent-guide.md を読んで、その手順に沿って私を案内してください。
```

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
