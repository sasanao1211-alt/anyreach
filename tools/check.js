#!/usr/bin/env node
// 設定が正しいかを1コマンドで確かめる。読み取りだけで、何も書き込まない。
//
//   GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... GMAIL_REFRESH_TOKEN=... npm run check
//
// クラウドセッションに載せる前に、手元でここまで通しておくと切り分けが早い。

const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];

const ok = (msg) => console.log(`  ok   ${msg}`);
const ng = (msg, hint) => {
  console.log(`  NG   ${msg}`);
  if (hint) console.log(`       ${hint}`);
  process.exitCode = 1;
};

(async () => {
  const missing = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']
    .filter((name) => !process.env[name]);
  if (missing.length) {
    ng(`環境変数が未設定: ${missing.join(', ')}`, '.env.example を参照。');
    return;
  }
  ok('環境変数が3つとも入っている');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const token = await res.json();

  if (!res.ok) {
    if (JSON.stringify(token).includes('invalid_grant')) {
      ng('refresh token が失効している', [
        'よくある原因:',
        '         1. OAuth同意画面が「テスト」のまま → refresh token は7日で失効する',
        '         2. Workspace管理者にアプリを遮断された',
        '       npm run token で取り直せる。',
      ].join('\n'));
    } else {
      ng(`トークン取得に失敗 (${res.status})`, JSON.stringify(token));
    }
    return;
  }
  ok('refresh token からアクセストークンを取得できた');

  const granted = (token.scope ?? '').split(' ');
  for (const scope of REQUIRED_SCOPES) {
    if (granted.includes(scope)) ok(`スコープ ${scope.split('/').pop()} が許可されている`);
    else ng(`スコープ ${scope} が無い`, '同意画面でスコープを外した可能性。npm run token で取り直す。');
  }

  const profileRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!profileRes.ok) {
    ng(`Gmail APIを叩けない (${profileRes.status})`, await profileRes.text());
    return;
  }
  const profile = await profileRes.json();
  ok(`Gmail APIに到達できた`);

  console.log(`\n接続先: ${profile.emailAddress}`);
  if (!profile.emailAddress.endsWith('@anymindgroup.com')) {
    console.log('警告: AnyMindのアカウントではない。同意画面で選んだアカウントを確認すること。');
    process.exitCode = 1;
  }
  console.log(process.exitCode ? '\n問題あり。上のNGを潰すこと。' : '\n問題なし。クラウド環境に同じ3つの環境変数を登録すれば使える。');
})().catch((err) => {
  console.error(`\n想定外のエラー: ${err.message}`);
  process.exit(1);
});
