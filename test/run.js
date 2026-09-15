// 本体を子プロセスとして起動し、stdio越しに実際のツールを呼んで結果を検証する。
// fetch はモックに差し替わっているので、Googleの認証情報なしで全経路を通せる。
//   npm test

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DUMP = path.join(os.tmpdir(), `anyreach-drafts-${process.pid}.txt`);
fs.writeFileSync(DUMP, '');

const child = spawn('node', ['--require', './test/mock-gmail.js', 'src/server.js'], {
  cwd: path.join(__dirname, '..'),
  stdio: ['pipe', 'pipe', 'inherit'],
  env: {
    ...process.env,
    MOCK_DUMP: DUMP,
    GMAIL_CLIENT_ID: 'mock-id',
    GMAIL_CLIENT_SECRET: 'mock-secret',
    GMAIL_REFRESH_TOKEN: 'mock-refresh',
  },
});

const pending = new Map();
let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
});

let nextId = 1;
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

const call = async (name, args = {}) => {
  const res = await rpc('tools/call', { name, arguments: args });
  assert.ok(res.result, `${name} が result を返さない: ${JSON.stringify(res)}`);
  const text = res.result.content[0].text;
  assert.ok(!res.result.isError, `${name} が失敗した: ${text}`);
  return text;
};

const checks = [];
const check = (label, fn) => checks.push([label, fn]);

check('initialize がサーバー情報を返す', async () => {
  const res = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.strictEqual(res.result.serverInfo.name, 'anyreach-gmail');
  assert.deepStrictEqual(res.result.capabilities, { tools: {} });
});

check('tools/list が5つのツールを返す', async () => {
  const res = await rpc('tools/list');
  assert.deepStrictEqual(
    res.result.tools.map((t) => t.name).sort(),
    ['create_draft', 'get_profile', 'get_thread', 'list_drafts', 'search_threads']
  );
  // 送信ツールが紛れ込んでいないこと。下書きまでが責任範囲。
  assert.ok(!res.result.tools.some((t) => /send/i.test(t.name)), '送信ツールが存在してはいけない');
});

check('get_profile が接続先アカウントを返す', async () => {
  assert.match(await call('get_profile'), /xc-naoto\.sasahara@anymindgroup\.com/);
});

check('search_threads が同一スレッドを1件に畳む', async () => {
  const text = await call('search_threads', { query: 'is:unread' });
  assert.match(text, /^1件/m, `1件に畳まれていない:\n${text}`);
  assert.match(text, /threadId: t1/);
  assert.match(text, /件名: そらまめ 日次実績の確認/);
});

check('get_thread が text/plain を優先して復号する', async () => {
  const text = await call('get_thread', { threadId: 't1' });
  assert.match(text, /CPAの件、相談させてください。/);
  assert.ok(!text.includes('使われないはず'), 'text/plain があるのに html を拾っている');
  assert.match(text, /messageId: m1/, '返信に使う messageId が出ていない');
});

check('get_thread が text/html しかない本文をタグ落としして読む', async () => {
  const text = await call('get_thread', { threadId: 't1' });
  assert.match(text, /承知しました。\n明日お時間ください。/, 'htmlのタグ落としが効いていない');
  assert.ok(!/<p>|<style>|color:red/.test(text), 'styleやタグが残っている');
});

check('get_thread の maxChars で本文が切り詰められる', async () => {
  const text = await call('get_thread', { threadId: 't1', maxChars: 10 });
  assert.match(text, /文字省略/);
});

check('create_draft が新規下書きを作る', async () => {
  const text = await call('create_draft', {
    to: ['keita.chino@anymindgroup.com'],
    subject: '【AnyReach】日次実績のご共有',
    body: 'お世話になっております。',
  });
  assert.match(text, /draftId: d1/);
  assert.match(text, /送信はしていない/);
});

check('create_draft の返信が宛先・件名・In-Reply-To を引き継ぐ', async () => {
  const text = await call('create_draft', { replyToMessageId: 'm1', body: '承知しました。' });
  assert.match(text, /threadId: t1/, '同じスレッドに入っていない');
  assert.match(text, /宛先: keita\.chino@anymindgroup\.com/, '元メールの差出人が宛先になっていない');
  assert.match(text, /件名: Re: そらまめ 日次実績の確認/, 'Re: が付いていない');

  const raw = fs.readFileSync(DUMP, 'utf8').split('===DRAFT===').filter((s) => s.trim())[1];
  assert.match(raw, /^In-Reply-To: <orig-m1@mail\.gmail\.com>$/m, 'In-Reply-To が無い');
  assert.match(raw, /^References: <older@mail\.gmail\.com> <orig-m1@mail\.gmail\.com>$/m, 'References が連結されていない');
  assert.match(raw, /^X-Mock-ThreadId: t1$/m, 'APIリクエストに threadId が載っていない（別スレッドの新規メールになる）');
});

check('日本語の件名と本文がMIMEで往復する', async () => {
  const raw = fs.readFileSync(DUMP, 'utf8').split('===DRAFT===').filter((s) => s.trim())[0];
  const subject = raw.match(/^Subject: =\?UTF-8\?B\?(.+)\?=$/m);
  assert.ok(subject, '件名が RFC 2047 でエンコードされていない');
  assert.strictEqual(Buffer.from(subject[1], 'base64').toString('utf8'), '【AnyReach】日次実績のご共有');

  const body = raw.split('\r\n\r\n')[1].replace(/\r\n/g, '');
  assert.strictEqual(Buffer.from(body, 'base64').toString('utf8'), 'お世話になっております。');
});

check('list_drafts が作成済みの下書きを返す', async () => {
  const text = await call('list_drafts');
  assert.match(text, /^2件/m);
  assert.match(text, /draftId: d1/);
  assert.match(text, /draftId: d2/);
});

check('宛先も replyToMessageId も無い create_draft は弾かれる', async () => {
  const res = await rpc('tools/call', { name: 'create_draft', arguments: { body: 'x' } });
  assert.ok(res.result.isError, '宛先不明なのにエラーになっていない');
  assert.match(res.result.content[0].text, /宛先を決められない/);
});

check('未知のツールは -32602 を返す', async () => {
  const res = await rpc('tools/call', { name: 'send_message', arguments: {} });
  assert.strictEqual(res.error.code, -32602);
});

(async () => {
  let failed = 0;
  for (const [label, fn] of checks) {
    try {
      await fn();
      console.log(`  ok   ${label}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL ${label}\n       ${err.message}`);
    }
  }
  child.stdin.end();
  fs.rmSync(DUMP, { force: true });
  console.log(`\n${checks.length - failed}/${checks.length} 通過`);
  process.exit(failed ? 1 : 0);
})();
