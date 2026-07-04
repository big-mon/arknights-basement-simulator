# Security Policy

## Supported Versions

現時点では公開中の最新版のみをサポート対象とします。

## Reporting a Vulnerability

脆弱性を見つけた場合は、GitHub Issue または作者のXアカウントから連絡してください。

- GitHub: https://github.com/big-mon/arknights-basement-simulator
- X: https://x.com/BIG_MON

公開Issueに詳細な攻撃手順や悪用可能なペイロードをそのまま貼るのは避けてください。影響範囲、再現条件、修正案の概要が分かる形で報告してください。

## App Security Notes

このアプリはフロントエンドのみで動作します。

- JSONインポートはブラウザ内で処理され、サーバーへ送信されません。
- 保存データは `localStorage` に保存されます。
- 認証情報、アクセストークン、秘密鍵などの保存は想定していません。
- JSONインポートにはサイズ制限と形状検証があります。

## Dependency Updates

依存関係の脆弱性が見つかった場合は、lockfileの差分と動作確認を含めて更新してください。

```powershell
pnpm test
pnpm build
```
