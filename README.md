# Kida OGP Debugger

Basic 認証がかかったサイトの OGP を確認するツール。

公開されている OGP チェッカーは Basic 認証に対応していないため、ステージング環境の OGP が確認できない。これは認証情報を手元から外に出さずに確認する。

デプロイ版: https://ogp-debugger.kidapu.workers.dev/ （Basic 認証あり）

## 起動

```bash
npx github:kidapu/OGP-Debugger
```

Node 18 以上があれば、これだけで起動してブラウザが開く。依存パッケージはない。

`PORT=8080` でポート変更、`NO_OPEN=1` でブラウザを開かない。

## できること

- Basic 認証付きで HTML と og:image を取得し、カードプレビューを表示
- X / Facebook / Slack / Discord / LINE それぞれの見え方を再現
- クローラの User-Agent を名乗って取得（UA で出し分けているサイト向け）
- noindex の判定（`<meta name="robots">` と `X-Robots-Tag` ヘッダの両方）
- タグの欠落、相対 URL、画像の実寸（1200×630 推奨）、文字数超過などを診断
- Shift_JIS / EUC-JP にも対応

URL はスキームを省略できる。`https://user:pass@example.com/` 形式でも認証情報を拾う。パスワードは既定では保存しない。

## Cloudflare Workers にデプロイ

スマホや別の PC からも使いたい場合。無料枠に収まる。

```bash
npm install
npx wrangler login
npm run cf:deploy

# デプロイ直後は 503 で止まっている。ここで認証情報を設定する
npx wrangler secret put BASIC_USER
npx wrangler secret put BASIC_PASS
```

デプロイ先は `https://<Worker 名>.<アカウント名>.workers.dev`（このリポジトリの場合は https://ogp-debugger.kidapu.workers.dev/ ）。

公開 URL には Basic 認証がかかる。シークレットを設定するまでは 503 を返して停止するので、設定を忘れたまま誰でも開ける状態にはならない。

デプロイ版では「JS 実行後の DOM も確認する」が使える。SNS のクローラは JS を実行しないが Googlebot は実行するので、JS で差し込まれた noindex や、JS でしか入れていない OGP をここで見つけられる。
