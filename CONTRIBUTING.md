# Contributing

このプロジェクトへのコントリビューションを歓迎します。

## 開発環境

- Node.jsは24 LTSを使用し、ローカルとCIの実行版を [`.node-version`](./.node-version) に揃えます。対応範囲は `package.json` の `engines.node` を正とし、EOLを迎える前に次のLTSへの移行を検証します。
- [`package.json`](./package.json) が指定するバージョンの `pnpm` を使います。利用可能なスクリプトも `package.json` を正とします。
- グローバルインストールや管理者権限は不要です。

```console
pnpm install
pnpm dev
```

## 変更前に確認してほしいこと

- 小さく焦点の合った変更にしてください。
- 関係ないリファクタリングやフォーマット変更は避けてください。
- 生成データと手動メンテナンスデータの役割を分けて扱ってください。

## よくある変更

### オペレーター名の修正

取り込み元、名称の優先順位、フォールバック方針は [`src/data/localization-sources.md`](./src/data/localization-sources.md) を先に確認してください。

1. `src/data/operator-name-overrides.json` を更新します。
2. 生成済みアプリデータも必要なら `src/data/operators.json` を更新します。
3. `src/App.test.tsx` に回帰テストを追加します。
4. 可能であれば、確認元をPR本文に記載してください。

### 基地スキルや最適化ロジックの修正

[`docs/specs/optimizer-accuracy-phase1.md`](./docs/specs/optimizer-accuracy-phase1.md) と、変更内容に応じて同仕様から案内される補足仕様を確認し、対象動作を証明する焦点の合った回帰テストを追加してください。

### ゲームデータの取り込み

```console
pnpm import:game-data
```

このコマンドは外部データを取得するネットワーク操作です。実行前にネットワーク利用が意図された作業か確認し、生成差分に意図しない名称変更やデータ欠落がないことをレビューしてください。

## 検証

変更種別ごとの完了条件は次のとおりです。複数に該当する場合は、該当行の検証をすべて実行してください。

| 変更種別 | 必須検証 |
| --- | --- |
| コードまたはoptimizer | `pnpm test`、`pnpm build`。Phase 1 optimizer仕様が管轄するoptimizer・benchmark・基地スキル変更では、さらに `pnpm audit:base-skills` |
| 生成済みoperator / 基地スキルデータ | `pnpm test`、`pnpm build`、`pnpm audit:base-skills`、`pnpm audit:localization`。生成差分をレビューし、手動overrideと生成値の責務が保たれていることを確認 |
| importer | `pnpm test`、`pnpm build`、`pnpm audit:base-skills`、`pnpm audit:localization`、対象に応じて `pnpm import:game-data`、`pnpm import:wiki-localization`、`pnpm import:wikiru-ja-localization` のいずれか。各importは外部取得を伴うため、使用したネットワーク操作と生成差分を報告 |
| UI | `pnpm test`、`pnpm build`、ローカル開発サーバーで変更した操作をブラウザ確認。デスクトップ幅と狭い画面幅で、変更対象の入力、選択状態、結果表示、および影響する各言語（日本語・中国語・英語）を確認 |
| docsのみ | ローカルMarkdownリンクの解決、記載したpackage scriptの存在、変更要件に関する禁止・必須文言を確認。`pnpm test` と `pnpm build` は不要 |

すべての変更で最後に `git diff --check` を実行してください。結果報告には、実行した各コマンドとブラウザ確認の成否を正確に記載します。実行できなかった項目は `未実行` とし、具体的な阻害要因を記載してください。

GitHub Actionsの `CI / validate` はPRとmainへのpushで、実行版の一致、frozen install、全テスト、build、`pnpm audit:base-skills`、`pnpm audit` を検証します。ローカルと同じarm64の標準macOS 15 runnerを使用し、計算量の多いoptimizerテスト同士のCPU競合を避けるため、CIでは `pnpm test --no-file-parallelism --testTimeout=30000` を使用します。共有runnerでの機能テストの待機時間を30秒とし、明示的な計算時間上限のassertionは維持します。

`package.json` の複合スクリプトを使う場合も、上表で追加指定された監査、ブラウザ確認、差分確認は別途実施してください。

## Pull Request

PRには以下を含めてください。

- 何を変更したか
- なぜ変更したか
- 実行した検証
- 残っている制限や不確かな点
