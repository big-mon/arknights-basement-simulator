# Security Policy

## Supported Versions

現時点では公開中の最新版のみをサポート対象とします。

## Reporting a Vulnerability

脆弱性を見つけた場合は、有効になっている GitHub Private Vulnerability Reporting から非公開で報告してください。

- Private report: https://github.com/big-mon/arknights-basement-simulator/security/advisories/new

この非公開窓口が利用できない場合は、作者のXアカウント https://x.com/BIG_MON へ非公開で連絡するか、連絡調整だけを目的とした公開Issueを作成してください。公開Issueには、攻撃・再現手順、悪用可能なペイロード、秘密情報、未公開・公開猶予中の情報を含めず、公開して安全な概要と非公開連絡手段の相談だけを記載してください。

## App Security Notes

このアプリはフロントエンドのみで動作します。

- JSONインポートはブラウザ内で処理され、サーバーへ送信されません。
- 保存データは `localStorage` に保存されます。
- 認証情報、アクセストークン、秘密鍵などの保存は想定していません。
- JSONインポートにはサイズ制限と形状検証があります。

## Dependency Updates

依存関係の脆弱性が見つかった場合は、lockfileの差分と動作確認を含めて更新してください。

```console
pnpm test
pnpm build
```
