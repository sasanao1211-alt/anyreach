# anyreach

AnyMind（AnyReach）アカウント `xc-naoto.sasahara@anymindgroup.com` のメールを
**Claude Code のクラウドセッションから読んで、下書きを作る**ためのMCPサーバー。

送信はしない。**下書きを作るところまで**が責任範囲で、送信ツールは意図的に実装していない。

## なぜ純正コネクタではダメなのか

Claude の Gmail コネクタは**1つのGoogleアカウントにしか繋がらない**。
個人Gmail（`sasanao1211@gmail.com`）に繋いだままAnyMind側も見たい、という要求を
純正コネクタだけでは満たせない。切り替えるしかなくなる。

一方、クラウドセッションは**クローンしたリポジトリの `.mcp.json` を読み込む**
（[Configure cloud environments](https://code.claude.com/docs/en/cloud-environments) の
"What carries over to cloud sessions" 表に明記されている）。
そこで2つ目のGmailを自前のMCPサーバーとして足す。結果こうなる：

| アカウント | 経路 | ツール名 |
|---|---|---|
| sasanao1211@gmail.com | Claude純正コネクタ | `mcp__Gmail__*` |
| xc-naoto.sasahara@anymindgroup.com | このリポジトリの `.mcp.json` | `mcp__anyreach-gmail__*` |

**両方が同時に生きる。** 名前空間が分かれているので取り違えも起きない。

## 依存パッケージはゼロ

Node 20+ の組み込み `fetch` だけで動く。`npm install` は不要。
（`soramame-ads-sync` と同じ方針。依存の更新で壊れないため）

## セットアップ

### 1. Google Cloud 側

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作る
2. **Gmail API** を有効化
3. **OAuth同意画面**を設定
   - AnyMindのGCP組織内で作れるなら「**内部**」を選ぶ。これが一番楽（審査も7日失効も無い）
   - 個人プロジェクトで作る場合は「外部」になる。**必ず「本番」に上げること**（後述）
4. **認証情報 → OAuthクライアントID → デスクトップアプリ** を作成
5. クライアントIDとシークレットを控える

スコープは `gmail.readonly` と `gmail.compose` の2つだけ。
`gmail.compose` は仕様上「送信」も含むが、このサーバーは送信ツールを一切公開していない。

### 2. refresh token を取る（手元のPCで一度だけ）

**クラウドセッションではブラウザOAuthができない**
（ドキュメントに "Interactive auth → Not supported" と明記）ので、ここだけはローカルで。

```bash
git clone https://github.com/sasanao1211-alt/anyreach.git
cd anyreach

GMAIL_CLIENT_ID=xxx.apps.googleusercontent.com \
GMAIL_CLIENT_SECRET=GOCSPX-xxx \
node tools/get-refresh-token.js
```

表示されたURLをブラウザで開き、**AnyMindのアカウントで**同意する。
ターミナルに `GMAIL_REFRESH_TOKEN=...` が出る。

### 2.5. 手元で疎通確認

クラウドに載せる前に、ローカルで通しておくと切り分けが早い。読み取りだけで何も書き込まない。

```bash
GMAIL_CLIENT_ID=xxx GMAIL_CLIENT_SECRET=yyy GMAIL_REFRESH_TOKEN=zzz npm run check
```

環境変数・トークン交換・スコープ・API到達・接続先アカウントを順に確認して、
落ちた場所と対処を出す。

### 3. クラウド環境に環境変数を登録

claude.ai → **設定 → 環境** → 使っている環境 → 環境変数に3つ登録する：

| 変数 | 中身 |
|---|---|
| `GMAIL_CLIENT_ID` | OAuthクライアントID |
| `GMAIL_CLIENT_SECRET` | OAuthクライアントシークレット |
| `GMAIL_REFRESH_TOKEN` | 手順2で取得した値 |

### 4. ネットワークアクセスを許可

同じ環境設定の **Network access**。**Trusted** のままで足りなければ **Custom** にして、
許可ドメインに次を追加する：

```
gmail.googleapis.com
oauth2.googleapis.com
```

### 5. 確認

このリポジトリでクラウドセッションを開いて、Claudeにこう言う：

> get_profile を実行して、どのアカウントに繋がっているか教えて

`接続先: xc-naoto.sasahara@anymindgroup.com` が返れば完了。

## 使えるツール

| ツール | 用途 |
|---|---|
| `get_profile` | 接続先アカウントの確認。まずこれ |
| `search_threads` | Gmail検索構文でスレッド一覧（本文なし） |
| `get_thread` | スレッドを本文込みで取得 |
| `create_draft` | 下書き作成。`replyToMessageId` を渡せば返信下書きになる |
| `list_drafts` | 下書き一覧 |

返信下書きを作るときは `replyToMessageId` を渡すこと。
宛先・件名（`Re:` 付与）・`In-Reply-To` を元メールから引き継いで、
**同じスレッドの中に**下書きが入る。これを省くと別スレッドの新規メールになってしまう。

使用例：

> 今週届いた船井総研さん関連の未読メールを探して、返信が要るものの下書きを作って

## ハマりどころ

### refresh token が7日で失効する

OAuth同意画面が「**テスト**」状態のままだと、Googleは refresh token を7日で切る。
毎週取り直す羽目になるので、**「本番」に上げる**か、AnyMindのGCP組織内で
「内部」アプリとして作ること。

失効すると `invalid_grant` が返る。サーバー側でこのエラーを検知して案内を出すようにしてある。

### Workspace管理者に遮断される可能性

`@anymindgroup.com` は AnyMind Group の管理下にある。
管理者はサードパーティ製OAuthクライアントを**クライアントID単位で遮断できる**ので、
同意画面で弾かれたら管理者に許可申請が要る。

**これは技術で回避できる問題ではない。** 会社のメールに外部からアクセスする以上、
AnyMind側の許可とルールの問題になる。事前に確認しておくこと。

### refresh_token が返ってこない

同じアカウントで過去に同意済みだと、Googleは refresh token を再発行しないことがある。
[アカウントのアクセス権限](https://myaccount.google.com/permissions) から
このアプリを削除して、`tools/get-refresh-token.js` を再実行する。

## 構成

```
.mcp.json                    MCPサーバーの宣言。クラウドセッションはこれを読む
src/server.js                本体。JSON-RPC over stdio、依存ゼロ
tools/get-refresh-token.js   初回のトークン取得（ローカル実行専用）
tools/check.js               設定の疎通確認（npm run check）
test/                        モックGmail APIを相手にした結合テスト（npm test）
.env.example                 必要な環境変数の一覧
```

## テスト

```bash
npm test
```

`fetch` をモックに差し替えて本体を子プロセスで起動し、stdio越しに全ツールを呼ぶ。
Googleの認証情報なしで、検索・本文復号・下書き作成・返信ヘッダの引き継ぎまで通る。

テスト自体が機能しているかは変異テストで確認してある。
`References` の連結、`text/plain` の優先、件名のRFC 2047エンコード、
返信時の `threadId` 付与 —— それぞれ壊すとテストが落ちる。
