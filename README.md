# reminder-server

軽量なリマインダー管理用の Express サーバーです。

主な特徴:
- シンプルな REST API（`/reminders`）でリマインダーの取得・更新を行います
- 開発モードは TypeScript を ts-node/ nodemon で直接実行
- 本番はビルド済みの `dist/app.js` を Node で動かすか Docker イメージを利用
- 本番モードでは HTTPS を使い、証明書ディレクトリの変更検知でサーバー再起動（ホットリロード）します

## 必要条件
- Node.js 22 系（Docker イメージは Node 22.14.0 ベース）
- npm
- 開発時: `ts-node`, `nodemon`（devDependencies に含まれています）

## リポジトリ構成（主要ファイル）
- `src/app.ts` - Express アプリ本体（証明書の監視・再読み込み処理含む）
- `src/router/index.ts` - `/reminders` のルーティング
- `src/util/reminderUtils.ts` - 簡易的なファイルベースのストレージ（デフォルトは `./reminders.txt`）
- `Dockerfile` - マルチ段階ビルド（tsup でバンドルして最終イメージで実行）
- `nodemon.json` - 開発時の起動設定

## 環境変数
- `NODE_ENV` - `development`（デフォルト）または `production`
- `PORT` - サーバーがリッスンするポート（デフォルト: `3000`）
- `CERT_PATH` - production 時に使用する証明書ディレクトリ（`cert.pem` と `privkey.pem` を配置）
- `STORAGE_FILE` - リマインダー保存先ファイル（デフォルト: `./reminders.txt`）

## 開発（ローカル）
1. 依存パッケージをインストール

```bash
npm install
```

2. 開発モードで起動（`nodemon` → `ts-node` を利用）

```bash
npm run start
# nodemon は `nodemon.json` の設定により: ts-node -r tsconfig-paths/register ./src/app.ts を実行します
```

開発モードでは `NODE_ENV` が `development` と判定され、通常の HTTP サーバー（`app.listen`）で起動します。

## 本番（ローカルでの簡易ビルド）
1. ビルド

```bash
npx tsup
```

2. ビルド済みファイルを Node で実行

```bash
NODE_ENV=production CERT_PATH=/path/to/certs PORT=443 node dist/app.js
```

注意: production モードでは HTTPS（`https.createServer`）を使用します。`CERT_PATH` に `cert.pem` と `privkey.pem` を置いてください。
サーバーはそのディレクトリのファイル変更を監視し、`cert.pem` または `privkey.pem` が更新されたら再起動して新しい証明書をロードします。

## Docker
Dockerfile は multi-stage ビルドを使用しています（tsup でビルド → 軽量イメージで実行）。

簡単なビルド / 実行例:
### Docker Compose での実行
このリポジトリには既に `docker-compose.yml` がルートにあります。内容は主に以下の点を想定しています（実際のファイルはリポジトリの `docker-compose.yml` を参照してください）：

- ローカルの `reminders.json` をコンテナ内 `/app/reminders.json` にマウント
- ホストの Let's Encrypt 証明書（例: `/etc/letsencrypt`）をコンテナの同パスに読み取り専用でマウント
- 環境変数として `NODE_ENV=production`、`CERT_PATH`、`STORAGE_FILE` 等を設定可能
- ポート 3000 を公開

リポジトリ付属の `docker-compose.yml`（抜粋、実際のファイルを参照）:

```yaml
services:
  reminder-server:
    build: 
      context: .
      args:
          ARCH: 
    image: reminder-server:latest
    volumes:
        - ./reminders.json:/app/reminders.json
        - /etc/letsencrypt:/etc/letsencrypt:ro
    environment:
        TZ: Asia/Tokyo
        NODE_ENV: production
        PORT: 
        STORAGE_FILE: 
        ALLOW_DOMAIN: 
        CERT_PATH: 
    ports:
        - 3000:3000
    init: true
    restart: always
```

Compose を使ったビルドと起動コマンド:

```bash
# イメージをビルドしてコンテナを起動
docker compose up --build -d

# コンテナのログを追う
docker compose logs -f reminder-server

# 停止して削除
docker compose down
```

実運用時のポイント:
- `CERT_PATH` を `docker-compose.yml` の `environment` か `volumes` と合わせて適切に設定してください（このリポジトリの例では `/etc/letsencrypt` をマウントしているので `CERT_PATH=/etc/letsencrypt/live/your-domain` のように指定します）。
- `STORAGE_FILE` を設定すると、デフォルトの `./reminders.txt` ではなく指定ファイルを使用します（Compose ではボリュームマウントで永続化してください）。
- `reminders.json` を `/app/reminders.json` にマウントしているため、Compose 構成の `STORAGE_FILE` を `/app/reminders.json` に合わせると動作が分かりやすくなります。
- ホスト側で証明書を更新するとコンテナ内の `fs.watch` が検知してサーバーを再起動して新しい証明書を読み込みます。ただし、ボリュームマウント方式や OS によっては `fs.watch` が確実に検知しない場合があるため動作確認を行ってください。

レスポンスは `src/util/reminderUtils.ts` に基づき、`STORAGE_FILE`（デフォルト `./reminders.txt`）に JSON オブジェクトとして保存／読取します。

簡単な curl 例:

```bash
# 保存
curl -X PUT -H "Content-Type: application/json" \
  -d '{"key":"me","reminders":[{"title":"テスト","time":"2025-11-03T09:00:00Z"}]}' \
  http://localhost:3000/reminders

# 取得
curl -X POST -H "Content-Type: application/json" \
  -d '{"key":"me"}' http://localhost:3000/reminders
```

## 注意点 / 制限
- 現状のストレージは単一ファイルの同期的な読み書きです。大量のデータや同時書き込みが発生するユースケースではデータ破損やパフォーマンス問題があります。必要ならデータベース（SQLite / PostgreSQL など）への移行を検討してください。
- 証明書の再読み込みはファイルシステム監視（`fs.watch`）で行っていますが、環境によっては挙動が変わる場合があります（特にネットワークファイルシステム）。
