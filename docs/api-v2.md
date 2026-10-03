# Reminder API v2

HTTP API Gatewayのpayload format 2.0からLambdaへ渡すAPI。既存の一覧全体を上書きするAPIを廃止し、認証した所有者の項目ごとに作成・取得・更新・削除する。通常起動で旧JSONを読み書きしたり、自動移行したりしない。

## エンドポイントと認証

| method / path | 応答 | 必須scope |
| --- | --- | --- |
| GET /v2/reminders | 200 `{items, nextCursor}` | `reminder-api/read` |
| GET /v2/reminders/{id} | 200 項目DTO、ETag | `reminder-api/read` |
| GET /v2/reminders/{id}/thumbnail-url | 200 画像URL DTO | `reminder-api/read` |
| POST /v2/reminders | 201 項目DTO、ETag、Location | `reminder-api/write` |
| PATCH /v2/reminders/{id} | 200 項目DTO、ETag。If-Match必須 | `reminder-api/write` |
| DELETE /v2/reminders/{id} | 200 `{id, deleted: true, revision}`。If-Match必須 | `reminder-api/write` |
| GET /healthz | 200 `{healthy: true}` | 不要 |
| GET /readyz | 200 `{ready: true}` または503 | 不要 |

`Authorization: Bearer <Cognito access token>`を使う。Gatewayが署名・issuer・audience・必要scopeを検証し、handlerも構成したAPI/stage、access tokenのissuer/client_id/token_use/sub/exp/iat/scopeとGateway scopeを照合する。所有者はissuerとsubから導出し、本文・クエリで所有者を指定できない。設定した送信元IP制限はGatewayのsourceIpに適用する。

v2はGateway境界、認証、所有者レート、公開状態、入力検証、保存処理の順で実行する。認証・scope・IPで拒否したリクエストは所有者レートを消費しない。認証済みの不正本文・不正ID・未公開リクエストもレートを消費する。rate保存失敗では後続の項目変更を行わない。

旧`POST /reminders`と`PUT /reminders`は410で次を返す。本文を解析せず、旧保存処理を実行しない。存在しないpathは404、不許可methodは405と`Allow`を返す。

```json
{"code":"LEGACY_API_REMOVED","message":"Use the item-based API","requestId":"req-123","replacement":"/v2/reminders"}
```

`/healthz`はtable/bucketへアクセスしない。`/readyz`は設定、必要な3tableの読み取り、bucketへのアクセス、初回公開gateを確認し、未公開や障害時は503を返す。module importで設定を読み込まず、クライアントやサーバーを起動しない。設定が不正な場合は構造が妥当なGateway health eventのlivenessだけ200を返せる。ready・v2・その他の処理は503で停止する。設定が有効な場合はhealthにも構成したAPI/stage境界を適用する。

## 書き込みDTO

POSTの全フィールドは以下。`thumbnail`だけ省略可能で、省略はnull。未知のフィールドを拒否し、文字列・数値を真偽値へ型変換しない。

```json
{
  "id": "reminder-1",
  "url": "https://example.test/reminder",
  "title": "Test reminder",
  "reminderTime": "2026-10-03T09:00:00+09:00",
  "autoOpen": false,
  "webPush": true,
  "hidden": false,
  "thumbnail": null
}
```

| field | 規則 |
| --- | --- |
| id | 空でないwell-formed Unicode文字列、制御文字・unpaired surrogateなし、最大128 Unicode code point |
| url | http/https URL、最大4096 code point |
| title | 文字列、最大1024 code point。空文字可 |
| reminderTime | 実在する日時、ZまたはUTC offset必須。UTCへ正規化。過去日時も可 |
| autoOpen / webPush / hidden | JSON boolean |
| thumbnail | null、空文字、canonical BASE64、または`data:image/png;base64,...`などのdata URL |

thumbnailはPNG/JPEG/GIF/WebPのsignatureとdata URLの宣言を照合する。不正なalphabet・padding・pad bitsや未対応形式を拒否し、元画像のバイト列を変換せず保存する。null・空文字は画像なしを意味する。

PATCHはid以外の書き込みfieldの部分集合で、最低1field必須。省略したfieldは維持し、thumbnailの省略は現在の画像を維持、null・空文字は画像を外す。`id`・revision・createdAt・updatedAtや画像メタデータを直接書き込めない。

Content-Typeは`application/json`（UTF-8 charset指定可）。JSONはUTF-8で、本文制限はBASE64の文字数ではなくGatewayデコード後のバイト数で判定する。pathのIDはクライアントがURI encodeする。例えば文字列`%2F`のLocationは`/v2/reminders/%252F`。handlerはGatewayのpathParametersを再decodeしないため、`/`、`%2F`、`%25`、UnicodeのID同一性を保持する。

## 読み取りDTO、一覧とETag

GET項目・POST結果・PATCH結果は同じserializerで、以下のfield順・UTC日時・null表記を使う。

```json
{
  "id": "reminder-1",
  "url": "https://example.test/reminder",
  "title": "Test reminder",
  "reminderTime": "2026-10-03T00:00:00.000Z",
  "autoOpen": false,
  "webPush": true,
  "hidden": false,
  "revision": 1,
  "createdAt": "2026-10-03T00:00:00.000Z",
  "updatedAt": "2026-10-03T00:00:00.000Z",
  "thumbnail": {
    "imageId": "00000000-0000-4000-8000-000000000001",
    "mime": "image/png",
    "bytes": 12,
    "sha256": "<64 lowercase hex characters>"
  }
}
```

画像なしの場合は`thumbnail: null`。読み取りへBASE64、S3 key/versionId、署名URL、ownerIdを含めない。revisionは1から開始し、更新と削除で増加する。DELETE結果は`{"id":"reminder-1","deleted":true,"revision":3}`だけで、本文や画像参照は保持しない。削除IDの再利用は409。

項目表現の強いETagは完全なJSONバイト列に対応する。クライアントは引用符込みのheader値を不透明な値として保存し、revisionから生成しない。PATCH/DELETEはその値を`If-Match`で送る。単一の強いETagのみ受け付け、弱いETag、`*`、複数値は422。欠落428、不一致412。競合時は最新項目を取得し、利用者の変更を確認して再送する。

項目GET/POST/PATCHは`Cache-Control: private, no-store, no-transform`とETagを返す。一覧、DELETE、画像URLへ項目のETagを付けない。共通応答はJSON Content-Type、`X-Request-Id`、`X-Content-Type-Options: nosniff`を持つ。

一覧は`?limit=20&cursor=<opaque value>`。既定20、1〜50の評価件数を指定できる。cursorは所有者に結び付けられ、偽造・他所有者・不正形式は422。cursorの構造やDB keyをクライアントで組み立てない。

```json
{"items":[],"nextCursor":null}
```

保存項目なしも200。削除記録だけの評価ページでは`items: []`かつ`nextCursor`が文字列になることがある。itemsが空でもnextCursorがnullになるまでページを続ける。一覧DTOには項目ETagを含めないため、更新前に項目GETを行う。

## 画像URL DTOとオフライン

```json
{
  "url": "https://synthetic.example.test/image?signature=example",
  "expiresAt": "2026-10-03T00:15:00.000Z",
  "imageId": "00000000-0000-4000-8000-000000000001",
  "revision": 1
}
```

認証済みの画像URL endpointは現在の画像に対する900秒のURLを発行し、revisionを変更しない。`Cache-Control: no-store`、ETagなし。expiresAtは要求有効期間の終了目安であり、署名元credentialの期限などで早く失敗する場合がある。URLの発行は元画像の恒久的な可用性を保証しない。

S3への画像GETにCognito Bearerを送らない。URLは秘密として扱い、ログ・永続同期データへ保存しない。URL失効はAPIトークンの期限と別に処理し、オンラインでURLを再取得する。オフライン表示にはクライアント側で取得済み画像のバイト列を保存する。Cognitoの失効だけで既存のS3 URLが即座に失効するとは扱わない。

## エラーと上限

Lambdaが返すエラーはtop-levelのcode・安全なmessage・requestIdを持つ。入力本文、Bearer、画像、署名URL、AWS内部エラーは含めない。

```json
{"code":"OWNER_RATE_LIMIT_EXCEEDED","message":"Rate limit exceeded","requestId":"req-123","retryAfterSeconds":1}
```

| status / code | 対処 |
| --- | --- |
| 400 INVALID_GATEWAY_EVENT / INVALID_BODY / INVALID_JSON | Gateway構造・canonical BASE64・JSONを修正 |
| 401 UNAUTHORIZED | 有効なaccess tokenとscopeを確認 |
| 403 SOURCE_IP_FORBIDDEN | 構成した送信元IPを確認 |
| 404 REMINDER_NOT_FOUND / THUMBNAIL_NOT_FOUND / ROUTE_NOT_FOUND | 対象またはpathを確認 |
| 405 METHOD_NOT_ALLOWED | Allow headerのmethodを使用 |
| 409 ALREADY_EXISTS | 別IDを使う。削除IDも再利用不可 |
| 410 LEGACY_API_REMOVED | /v2/remindersへ移行 |
| 412 PRECONDITION_FAILED | 最新項目をGETし競合を解決 |
| 413 PAYLOAD_TOO_LARGE / THUMBNAIL_TOO_LARGE | 本文または画像を小さくする |
| 413 OWNER_STORAGE_LIMIT_EXCEEDED | 既存項目や画像を整理。待つだけでは解除されない |
| 415 UNSUPPORTED_MEDIA_TYPE | application/jsonを使用 |
| 422 INVALID_INPUT / INVALID_THUMBNAIL / INVALID_IF_MATCH / INVALID_LIMIT / INVALID_CURSOR | 入力を修正。自動型変換なし |
| 428 PRECONDITION_REQUIRED | 項目GETでETagを取得しIf-Matchを送る |
| 429 OWNER_RATE_LIMIT_EXCEEDED | Retry-Afterと同じ整数秒がretryAfterSecondsに入る。待機にjitterを加えて回数制限付きで再試行 |
| 503 SERVICE_UNAVAILABLE | 未公開、期限不足、保存先・rate・設定障害。回数制限付きbackoff。結果不明の書き込みは先にGETして照合 |

所有者レートはUTC分ごとに既定120回まで。121回目以降のRetry-Afterは次の分境界まで切り上げた秒数で最低1秒。APIはLambda残り時間から1秒をreserveし、abortした操作のsettlementをawaitしてから応答する。

既定の本文上限は2,097,152 bytes（2 MiB）、画像はデコード後1,048,576 bytes（1 MiB）、有効項目1000件、所有者画像合計134,217,728 bytes（128 MiB）。`MAX_JSON_BYTES`、`MAX_THUMBNAIL_BYTES`、`MAX_OWNER_ITEMS`、`MAX_OWNER_IMAGE_BYTES`、`OWNER_REQUESTS_PER_MINUTE`は正の整数設定で上書きできる。現在の入力上限を下げても既存画像メタデータの読み取りを固定1 MiBで拒否しない。AWSプラットフォームのpayload制限は別に適用され、設定overrideによる回避を保証しない。

Gateway自身のJWT拒否（401）、scope拒否（403）、stage/route throttle（429）、payload制限のエラーはLambdaのcode/message/requestId形式とは異なり得る。Gateway429にアプリcodeやRetry-Afterを保証しない。headerがない場合も回数制限付きbackoffを使う。Gateway形式をステータスとともに処理し、全エラーがアプリ独自形式になるとは仮定しない。

CORSと認証なしOPTIONSはGateway設定（D05）に集約する。許可originは完全一致、credentials=false、必要なAuthorization/Content-Type/If-MatchとETag/Location/X-Request-Id/Retry-Afterの公開を設定する。handlerはAccess-Controlヘッダーを追加しない。未許可originが自動403になるとは扱わず、originを認証情報として信用しない。S3画像GETのCORSも別途必要。実Gatewayの署名検証、CORS、S3署名URL、IAM、Lambda freeze/timeoutはdeployment後の受け入れ試験で確認する。
