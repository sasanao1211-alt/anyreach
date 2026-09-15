// テスト用に fetch を差し替えて、Gmail API の振る舞いを模す。
//   node --require ./test/mock-gmail.js src/server.js
// 本体のコードには一切手を入れずに、APIを叩く経路を丸ごと通せる。

const fs = require('node:fs');

const b64url = (s) =>
  Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const headers = (pairs) => Object.entries(pairs).map(([name, value]) => ({ name, value }));

// スレッド t1: 2通。1通目は multipart(text/plain あり)、2通目は text/html のみ。
const MESSAGES = {
  m1: {
    id: 'm1',
    threadId: 't1',
    labelIds: ['INBOX', 'UNREAD'],
    snippet: '日次実績の件です',
    payload: {
      mimeType: 'multipart/alternative',
      headers: headers({
        From: 'Keita Chino <keita.chino@anymindgroup.com>',
        To: 'xc-naoto.sasahara@anymindgroup.com',
        Cc: 'xc-sho.tanaka@anymindgroup.com',
        Subject: 'そらまめ 日次実績の確認',
        Date: 'Mon, 14 Sep 2026 09:36:01 +0900',
        'Message-ID': '<orig-m1@mail.gmail.com>',
        References: '<older@mail.gmail.com>',
      }),
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('笹原さん\n\n日次実績を確認しました。\nCPAの件、相談させてください。\n') } },
        { mimeType: 'text/html', body: { data: b64url('<p>使われないはず</p>') } },
      ],
    },
  },
  m2: {
    id: 'm2',
    threadId: 't1',
    labelIds: ['INBOX'],
    snippet: 'html only',
    payload: {
      mimeType: 'text/html',
      headers: headers({
        From: 'Naoto Sasahara <xc-naoto.sasahara@anymindgroup.com>',
        To: 'keita.chino@anymindgroup.com',
        Subject: 'Re: そらまめ 日次実績の確認',
        Date: 'Mon, 14 Sep 2026 10:02:00 +0900',
        'Message-ID': '<orig-m2@mail.gmail.com>',
      }),
      body: { data: b64url('<style>p{color:red}</style><p>承知しました。<br>明日お時間ください。</p>') },
    },
  },
};

const drafts = [];

const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const path = u.pathname.replace('/gmail/v1/users/me', '');
  const method = init.method ?? 'GET';

  if (u.hostname === 'oauth2.googleapis.com') {
    return ok({ access_token: 'mock-access-token', expires_in: 3600 });
  }

  if (path === '/profile') {
    return ok({ emailAddress: 'xc-naoto.sasahara@anymindgroup.com', messagesTotal: 4210, threadsTotal: 3180 });
  }

  // 検索。同じスレッドの2通を返して、重複が畳まれるかを見る。
  if (path === '/messages' && method === 'GET') {
    return ok({ messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't1' }] });
  }

  const message = path.match(/^\/messages\/([^/]+)$/);
  if (message) {
    const msg = MESSAGES[message[1]] ?? drafts.find((d) => d.message.id === message[1])?.stored;
    if (!msg) return { ok: false, status: 404, text: async () => 'not found' };
    return ok(msg);
  }

  if (path === '/threads/t1') {
    return ok({ id: 't1', messages: [MESSAGES.m1, MESSAGES.m2] });
  }

  if (path === '/drafts' && method === 'POST') {
    const { message: sent } = JSON.parse(init.body);
    const raw = Buffer.from(sent.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    // テストから中身を検証できるように、生のMIMEを書き出す。
    if (process.env.MOCK_DUMP)
      fs.appendFileSync(process.env.MOCK_DUMP, `X-Mock-ThreadId: ${sent.threadId ?? '(なし)'}\r\n${raw}\n===DRAFT===\n`);

    const id = `d${drafts.length + 1}`;
    const head = Object.fromEntries(
      raw.split('\r\n\r\n')[0].split('\r\n').map((line) => {
        const at = line.indexOf(': ');
        return [line.slice(0, at), line.slice(at + 2)];
      })
    );
    drafts.push({
      id,
      message: { id: `dm${drafts.length + 1}`, threadId: sent.threadId },
      stored: {
        id: `dm${drafts.length + 1}`,
        threadId: sent.threadId,
        snippet: '(下書き)',
        payload: { headers: headers({ To: head.To ?? '', Subject: head.Subject ?? '', Date: '' }) },
      },
    });
    return ok({ id, message: { id: `dm${drafts.length}`, threadId: sent.threadId } });
  }

  if (path === '/drafts' && method === 'GET') {
    return ok({ drafts: drafts.map(({ id, message }) => ({ id, message })) });
  }

  throw new Error(`モックが未対応: ${method} ${u.href}`);
};
