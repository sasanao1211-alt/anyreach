#!/usr/bin/env node
// AnyMind(AnyReach)アカウント用の Gmail MCP サーバー。
//
// Claude純正のGmailコネクタは1つのGoogleアカウントにしか繋がらない。
// これを .mcp.json 経由で足すと、純正コネクタ(個人Gmail)と並行して
// 2つ目のアカウントを読み書きできる。
//
// 依存パッケージはゼロ。Node 20+ の組み込み fetch だけで動く。
// 送信ツールは意図的に実装していない（下書きまで）。

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SERVER_NAME = 'anyreach-gmail';
const SERVER_VERSION = '0.1.0';

// ---------------------------------------------------------------- 認証

let cachedToken = null;
let cachedUntil = 0;

async function accessToken() {
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;

  const missing = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']
    .filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(
      `環境変数が未設定: ${missing.join(', ')}\n` +
      'claude.ai → 設定 → 環境 で登録するか、ローカルなら .env を読ませること。README参照。'
    );
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    // invalid_grant はほぼ必ずこの2択なので、ここで案内まで出す。
    const hint = text.includes('invalid_grant')
      ? '\n\nrefresh token が失効している。よくある原因は2つ:\n' +
        '  1. OAuth同意画面が「テスト」状態 → refresh token は7日で失効する。「本番」に上げること\n' +
        '  2. Workspace管理者にアプリを遮断された\n' +
        'tools/get-refresh-token.js を再実行すれば取り直せる。'
      : '';
    throw new Error(`アクセストークンの取得に失敗 (${res.status}): ${text}${hint}`);
  }

  const json = JSON.parse(text);
  cachedToken = json.access_token;
  cachedUntil = Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000;
  return cachedToken;
}

async function gmail(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${await accessToken()}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gmail API ${res.status} ${path}: ${text}`);
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------- MIME

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const unb64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

// 日本語の件名は RFC 2047 のエンコードドワードにしないと文字化けする。
const encodeHeader = (s) =>
  /^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;

function buildRaw({ to, cc, subject, body, inReplyTo, references }) {
  const lines = ['MIME-Version: 1.0'];
  if (to?.length) lines.push(`To: ${to.join(', ')}`);
  if (cc?.length) lines.push(`Cc: ${cc.join(', ')}`);
  lines.push(`Subject: ${encodeHeader(subject ?? '')}`);
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(Buffer.from(body ?? '', 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'));
  return b64url(Buffer.from(lines.join('\r\n'), 'utf8'));
}

const header = (msg, name) =>
  msg?.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

function findPart(payload, mimeType) {
  if (!payload) return null;
  if (payload.mimeType === mimeType && payload.body?.data) return payload;
  for (const part of payload.parts ?? []) {
    const hit = findPart(part, mimeType);
    if (hit) return hit;
  }
  return null;
}

function bodyText(msg) {
  const plain = findPart(msg.payload, 'text/plain');
  if (plain) return unb64url(plain.body.data);
  const html = findPart(msg.payload, 'text/html');
  if (html) {
    return unb64url(html.body.data)
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return msg.snippet ?? '';
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n…(${s.length - n}文字省略)` : s);

// ---------------------------------------------------------------- ツール

const TOOLS = [
  {
    name: 'get_profile',
    description:
      'このサーバーが実際にどのGoogleアカウントに繋がっているかを返す。' +
      '設定が正しいかの確認に最初に使う。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search_threads',
    description:
      'Gmail検索構文でスレッドを検索し、日時・差出人・件名・スニペットの一覧を返す。' +
      '本文は含まれないので、読む必要があるものは get_thread に threadId を渡すこと。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail検索構文。例: is:unread from:example.com newer_than:7d' },
        maxResults: { type: 'number', description: '最大件数。既定10、上限50' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_thread',
    description: 'スレッドを本文込みで取得する。返信の下書きを作るときは、ここで得た messageId を create_draft の replyToMessageId に渡す。',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        maxChars: { type: 'number', description: '1通あたりの本文の最大文字数。既定4000' },
      },
      required: ['threadId'],
    },
  },
  {
    name: 'create_draft',
    description:
      '下書きを作成する。送信はしない（このサーバーに送信ツールは無い）。' +
      'replyToMessageId を渡すと、宛先・件名・In-Reply-To を元メールから引き継いで同じスレッドに下書きが入る。',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: '本文（プレーンテキスト）' },
        to: { type: 'array', items: { type: 'string' }, description: '宛先。返信時は省略すると元メールの差出人になる' },
        cc: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string', description: '件名。返信時は省略すると "Re: 元件名" になる' },
        replyToMessageId: { type: 'string', description: 'get_thread で得た messageId' },
      },
      required: ['body'],
    },
  },
  {
    name: 'list_drafts',
    description: '下書きの一覧を返す。',
    inputSchema: {
      type: 'object',
      properties: { maxResults: { type: 'number', description: '既定20' } },
    },
  },
];

const handlers = {
  async get_profile() {
    const p = await gmail('/profile');
    return `接続先: ${p.emailAddress}\n総メッセージ数: ${p.messagesTotal}\n総スレッド数: ${p.threadsTotal}`;
  },

  async search_threads({ query, maxResults = 10 }) {
    const limit = Math.min(Math.max(1, maxResults), 50);
    const list = await gmail(`/messages?q=${encodeURIComponent(query)}&maxResults=${limit}`);
    if (!list.messages?.length) return `該当なし: ${query}`;

    const metadataHeaders = ['From', 'To', 'Subject', 'Date']
      .map((h) => `metadataHeaders=${h}`)
      .join('&');
    const rows = await Promise.all(
      list.messages.map((m) => gmail(`/messages/${m.id}?format=metadata&${metadataHeaders}`))
    );

    const seen = new Set();
    const out = [];
    for (const msg of rows) {
      if (seen.has(msg.threadId)) continue;
      seen.add(msg.threadId);
      out.push(
        [
          `threadId: ${msg.threadId}`,
          `  日時: ${header(msg, 'Date')}`,
          `  差出人: ${header(msg, 'From')}`,
          `  件名: ${header(msg, 'Subject')}`,
          `  ラベル: ${(msg.labelIds ?? []).join(', ')}`,
          `  抜粋: ${msg.snippet ?? ''}`,
        ].join('\n')
      );
    }
    return `${out.length}件（検索: ${query}）\n\n${out.join('\n\n')}`;
  },

  async get_thread({ threadId, maxChars = 4000 }) {
    const thread = await gmail(`/threads/${threadId}?format=full`);
    const parts = (thread.messages ?? []).map((msg) =>
      [
        `--- messageId: ${msg.id}`,
        `日時: ${header(msg, 'Date')}`,
        `差出人: ${header(msg, 'From')}`,
        `宛先: ${header(msg, 'To')}`,
        header(msg, 'Cc') ? `Cc: ${header(msg, 'Cc')}` : null,
        `件名: ${header(msg, 'Subject')}`,
        '',
        clip(bodyText(msg), maxChars),
      ]
        .filter((line) => line !== null)
        .join('\n')
    );
    return `スレッド ${threadId}（${parts.length}通）\n\n${parts.join('\n\n')}`;
  },

  async create_draft({ to, cc, subject, body, replyToMessageId }) {
    let threadId;
    let inReplyTo;
    let references;

    if (replyToMessageId) {
      const metadataHeaders = ['From', 'Subject', 'Message-ID', 'References']
        .map((h) => `metadataHeaders=${h}`)
        .join('&');
      const original = await gmail(`/messages/${replyToMessageId}?format=metadata&${metadataHeaders}`);
      threadId = original.threadId;
      const messageId = header(original, 'Message-ID');
      inReplyTo = messageId || undefined;
      references = [header(original, 'References'), messageId].filter(Boolean).join(' ') || undefined;

      if (!to?.length) {
        const from = header(original, 'From');
        const addr = from.match(/<([^>]+)>/)?.[1] ?? from;
        to = addr ? [addr] : undefined;
      }
      if (!subject) {
        const original_subject = header(original, 'Subject');
        subject = /^re:/i.test(original_subject) ? original_subject : `Re: ${original_subject}`;
      }
    }

    if (!to?.length) throw new Error('to が空。replyToMessageId も無いので宛先を決められない。');

    const draft = await gmail('/drafts', {
      method: 'POST',
      body: JSON.stringify({ message: { raw: buildRaw({ to, cc, subject, body, inReplyTo, references }), threadId } }),
    });

    // APIが実際に返した threadId だけを信じる。ここでローカルの threadId に
    // フォールバックすると、スレッドに紐付いていないのに紐付いたと報告してしまう。
    const actualThreadId = draft.message?.threadId;
    const lines = [
      '下書きを作成した（送信はしていない）。',
      `draftId: ${draft.id}`,
      `threadId: ${actualThreadId ?? '(新規スレッド)'}`,
      `宛先: ${to.join(', ')}`,
      `件名: ${subject ?? ''}`,
    ];
    if (replyToMessageId && actualThreadId !== threadId) {
      lines.push('', `警告: 返信のつもりだが、下書きが元スレッド(${threadId})に入っていない。`);
    }
    lines.push('', 'Gmailの「下書き」フォルダで確認・編集して、送信はご自身で。');
    return lines.join('\n');
  },

  async list_drafts({ maxResults = 20 } = {}) {
    const limit = Math.min(Math.max(1, maxResults), 50);
    const list = await gmail(`/drafts?maxResults=${limit}`);
    if (!list.drafts?.length) return '下書きなし';

    const metadataHeaders = ['To', 'Subject', 'Date'].map((h) => `metadataHeaders=${h}`).join('&');
    const rows = await Promise.all(
      list.drafts.map(async (d) => {
        const msg = await gmail(`/messages/${d.message.id}?format=metadata&${metadataHeaders}`);
        return `draftId: ${d.id}\n  宛先: ${header(msg, 'To')}\n  件名: ${header(msg, 'Subject')}\n  抜粋: ${msg.snippet ?? ''}`;
      })
    );
    return `${rows.length}件\n\n${rows.join('\n\n')}`;
  },
};

// ---------------------------------------------------------------- JSON-RPC

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function dispatch(req) {
  const { id, method, params } = req;
  // 通知には id が無い。応答を返してはいけない。
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;

    case 'ping':
      return reply(id, {});

    case 'tools/list':
      return reply(id, { tools: TOOLS });

    case 'tools/call': {
      const handler = handlers[params?.name];
      if (!handler) return fail(id, -32602, `未知のツール: ${params?.name}`);
      try {
        const text = await handler(params.arguments ?? {});
        return reply(id, { content: [{ type: 'text', text }] });
      } catch (err) {
        return reply(id, { content: [{ type: 'text', text: `エラー: ${err.message}` }], isError: true });
      }
    }

    default:
      if (isNotification) return;
      return fail(id, -32601, `未実装のメソッド: ${method}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;

    let req;
    try {
      req = JSON.parse(line);
    } catch {
      fail(null, -32700, 'JSONとして解析できない');
      continue;
    }
    dispatch(req).catch((err) => {
      if (req.id !== undefined && req.id !== null) fail(req.id, -32603, err.message);
      else process.stderr.write(`[${SERVER_NAME}] ${err.stack}\n`);
    });
  }
});
process.stdin.on('end', () => process.exit(0));
