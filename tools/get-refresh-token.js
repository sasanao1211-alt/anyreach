#!/usr/bin/env node
// refresh token を取るための一度きりのスクリプト。**必ず手元のPCで実行すること。**
// クラウドセッションはブラウザを開けないので、ここだけはローカルでやる必要がある。
//
//   GMAIL_CLIENT_ID=xxx GMAIL_CLIENT_SECRET=yyy node tools/get-refresh-token.js
//
// ブラウザで同意すると refresh token が表示される。それを環境変数に登録する。

const http = require('node:http');

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];

const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('GMAIL_CLIENT_ID と GMAIL_CLIENT_SECRET を環境変数で渡すこと。');
  process.exit(1);
}

const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: SCOPES.join(' '),
  // この2つが無いと refresh token が返ってこない。
  access_type: 'offline',
  prompt: 'consent',
})}`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }

  const error = url.searchParams.get('error');
  if (error) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(`失敗: ${error}`);
    console.error(`\n認可が拒否された: ${error}`);
    console.error('Workspace管理者にアプリを遮断されている可能性がある。');
    server.close();
    process.exitCode = 1;
    return;
  }

  const code = url.searchParams.get('code');
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  const json = await tokenRes.json();
  if (!tokenRes.ok || !json.refresh_token) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('失敗。ターミナルを見ること。');
    console.error('\nトークン取得に失敗:', JSON.stringify(json, null, 2));
    console.error('\nrefresh_token が空の場合、同じアカウントで過去に同意済みのことが多い。');
    console.error('https://myaccount.google.com/permissions でこのアプリを削除してから再実行する。');
    server.close();
    process.exitCode = 1;
    return;
  }

  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    .end('取得できた。ターミナルに戻ること。このタブは閉じてよい。');

  console.log('\n取得できた。以下を環境変数に登録する:\n');
  console.log(`GMAIL_REFRESH_TOKEN=${json.refresh_token}\n`);
  console.log('登録先: claude.ai → 設定 → 環境 → 使っている環境 → 環境変数');
  console.log('（GMAIL_CLIENT_ID と GMAIL_CLIENT_SECRET も同じ場所に登録すること）\n');
  console.log('注意: OAuth同意画面が「テスト」状態のままだと、このトークンは7日で失効する。');
  console.log('      Google Cloud Console で「本番」に上げておくこと。\n');

  server.close();
});

server.listen(PORT, () => {
  console.log('\nブラウザで次のURLを開き、AnyMindのアカウントで同意する:\n');
  console.log(`${authUrl}\n`);
  console.log(`(${REDIRECT_URI} で待ち受け中…)`);
});
