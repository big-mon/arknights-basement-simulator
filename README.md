# アークナイツ基地ローテーションシミュレーター

アークナイツの所持オペレーターと基地構成から、貿易所・製造所・発電所などの配置案とローテーション案を確認するためのブラウザ向けシミュレーターです。

- 公開URL: https://arknights.damonge.com/
- Repository: https://github.com/big-mon/arknights-basement-simulator
- Author: https://x.com/BIG_MON

## Features

- 所持オペレーター、昇進段階、潜在、モジュール状態の管理
- 243 / 153 の基地構成切り替え
- 生産優先度に応じた施設配置の提案
- 2ローテーションの交代案表示
- 日本語、中国語、英語の表示切り替え
- 所持情報と基地設定のJSONエクスポート / インポート

## Notes

このアプリはファンメイドの非公式ツールです。ゲーム本体、Hypergryph、Yostar、各地域の運営会社とは関係ありません。

掲載しているオペレーター画像を含むゲームコンテンツの権利は、Hypergryphおよび各権利者に帰属します。公式または権利者から削除・修正等の要請をいただいた場合は、速やかに対応します。ご連絡は [@BIG_MON](https://x.com/BIG_MON) までお願いいたします。

最適化ロジックはブラウザ内で動くMVPレベルのモデルです。すべての基地スキル、特殊な条件、ゲーム内の細かな制約を完全に再現しているわけではありません。計算対象外の効果はアプリ内の注記に表示されます。

## Tech Stack

- Vite
- React
- TypeScript
- Vitest
- pnpm

Node関連ツールはこのマシンでは `mise` 管理です。グローバルインストールは不要です。

## Getting Started

```powershell
pnpm install
pnpm dev
```

開発サーバーは `127.0.0.1` で起動します。

## Scripts

```powershell
pnpm dev
pnpm test
pnpm build
pnpm validate
pnpm import:game-data
```

`pnpm import:game-data` は外部のゲームデータを取得するため、ネットワークアクセスが必要です。

## Data Sources

ゲームデータの取り込みには主に以下を利用しています。

- CN game data: `Kengxxiao/ArknightsGameData`
- Yostar game data: `Kengxxiao/ArknightsGameData_YoStar`
- Operator face icons: [`yuanyan3060/ArknightsGameResource`](https://github.com/yuanyan3060/ArknightsGameResource) (`avatar/`)

オペレーターの顔アイコンはゲームクライアント由来の素材です。画像の著作権はArknights / Hypergryphおよび各権利者に帰属します。

日本語名は地域差や実装時期の都合で未確定・未翻訳の場合があります。手動で確認した名称は `src/data/operator-name-overrides.json` に追加し、生成済みデータがチェックインされている場合は `src/data/operators.json` も更新してください。

## JSON Import / Export

アプリの保存データはブラウザ内の `localStorage` に保存されます。JSONエクスポートは、別ブラウザや別端末への移行のための機能です。

インポート時は以下の制限と正規化を行います。

- JSONファイルは 128KiB 以下
- 想定外の形状のJSONは拒否
- 範囲外の数値や型違いの値はデフォルトへフォールバック
- アップロードされたJSONはサーバーへ送信されず、ブラウザ内で処理

## Deployment

このリポジトリには Cloudflare Workers / Pages の静的アセット配信用 `wrangler.jsonc` が含まれます。

```powershell
pnpm build
```

ビルド成果物は `dist/` に生成されます。

## Contributing

不具合報告、名称修正、基地スキルの改善は歓迎です。詳しくは [CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。

## Security

脆弱性の報告やセキュリティ上の注意点は [SECURITY.md](./SECURITY.md) を参照してください。

## License

ライセンスは未定です。公開前に、再利用条件を明確にするためのライセンスファイルを追加してください。
