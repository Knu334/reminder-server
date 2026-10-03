# Chrome拡張のCognito認証契約

更新日: 2026-10-03。対象: [AWS設計書](superpowers/specs/2026-10-02-reminder-server-aws-design.md)のChrome拡張向け認証。クライアント実装は別リポジトリにあり、この文書は要求仕様である。

利用者はユーザー本人1人を想定する。CognitoのユーザーはAWSコンソールで管理し、リマインダーの取得・保存・更新は拡張から行う。認証方式は公開クライアントのAuthorization Code + PKCE/S256とし、アクセストークンは5分、IDトークンは5分、リフレッシュトークンは初期値30日とする。通常の操作ではトークンを自動更新し、5分ごとのパスワード入力を要求しない。

## 1. 構成と設定値

| 設定 | 内容 |
| --- | --- |
| API base URL | 環境のAPI Gateway HTTP APIのURL |
| Cognito auth base URL | 環境のAWS管理Cognitoドメイン。`/oauth2/authorize`、`/oauth2/token`、`/oauth2/revoke`、`/logout`の接続先 |
| issuer | 対象User Poolの発行元URL。認証ドメインとは異なる |
| Client ID | `generate_secret = false`の公開app clientのID。ユーザーIDではない |
| callback URL | `chrome.identity.getRedirectURL("cognito")`が返す正確なURL |
| sign-out URL | `chrome.identity.getRedirectURL("logout")`が返す正確なURL |
| scope | `openid reminder-api/read reminder-api/write` |

API/認証ドメイン・issuer・Client ID等は公開設定であり、ユーザー名・パスワード・トークンを配布設定へ含めない。常設AWS環境はproductionだけであり、1つのpool/client/domainに接続する。接続先設定の変更が必要になった場合も、API URLだけ変更して既存トークンを使い回さない。

callbackは`https://<extension-id>.chromiumapp.org/cognito`、sign-outは`https://<extension-id>.chromiumapp.org/logout`となる。それぞれCognitoのAllowed callback URLs / Allowed sign-out URLsへ登録する。ChromeがこのURLへのリダイレクトを捕捉し、ウィンドウを閉じてURLを拡張へ返すため、専用Webサーバーは不要である。開発用と配布用の拡張IDを確認し、必要な実際のURLを登録する。拡張IDの変更時はCognito設定も更新する。

Manifest V3では`identity`と`storage`権限を要求し、host_permissionsを実際のCognitoドメインとAPIドメインへ限定する。画像の取得にfetchを使う場合は、署名URLに使用する実際のS3画像バケットのホストも許可する。`<all_urls>`を認証通信のために要求しない。CSPにconnect-srcを設定する場合は同じ接続先を許可する。

APIのCORS originに必要なのは拡張の`chrome-extension://<extension-id>`等の呼び出し元であり、認証のcallback URLとは別である。トークン交換・更新・API通信は拡張のService Workerに集約する。content scriptから任意URLを指定してBearer付きfetchを実行できるメッセージAPIを作らない。

## 2. ログイン

1. 拡張の明示的な「ログイン」操作から開始する。起動だけで対話型ログイン画面を勝手に開かない。
2. 暗号学的な乱数でstateとPKCE code_verifierを生成する。verifierはRFC 7636に従い、例として32 random bytesをpaddingなしBase64URL化した43文字を使用する。challengeは`BASE64URL_NO_PADDING(SHA256(ASCII(code_verifier)))`とする。
3. 対象環境、callback URL、state、verifier、開始時刻を`chrome.storage.session`へ保存する。認可試行は1件ずつとし、10分で期限切れにする。Service Workerのグローバル変数だけを保存先にしない。
4. 次のパラメーターをURLSearchParamsでエンコードし、Cognitoの`/oauth2/authorize`を`chrome.identity.launchWebAuthFlow({ url, interactive: true })`で開く。

| パラメーター | 値 |
| --- | --- |
| response_type | `code` |
| client_id | 対象環境のClient ID |
| redirect_uri | 保存したcallback URL |
| scope | `openid reminder-api/read reminder-api/write` |
| state | 保存したランダム値 |
| code_challenge | verifierから計算したchallenge |
| code_challenge_method | `S256` |

5. Cognitoの画面でユーザー名・パスワードによる本人確認を行う。コンソールで作成した仮パスワードの変更もCognitoの画面で扱い、拡張がパスワードを保持しない。既存のCognitoログインセッションがある場合は入力が省略されることがある。
6. Chromeが返したURLのoriginとpathを保存したcallbackと照合し、stateの一致、試行の期限、OAuthのerror、codeの存在を検証する。取消・未定義の結果・state不一致でコード交換へ進まない。
7. 認可コードを直ちにトークンへ交換する。Cognitoの認可コードの期限は5分で、アクセストークンの期限とは別である。使用済みコードを無条件に再送しない。
8. 成功時・取消時・失敗時に認可試行のstate/verifierを破棄する。コード、state、verifier、callbackのquery全体をログへ記録しない。

交換はCognitoへHTTPS POSTし、Content-Typeは`application/x-www-form-urlencoded`とする。本文はJSONではなく、以下のフォーム項目をURLSearchParamsで生成する。

| `/oauth2/token`へのフォーム項目 | 値 |
| --- | --- |
| grant_type | `authorization_code` |
| client_id | 対象環境のClient ID |
| code | callbackから取得した認可コード |
| redirect_uri | 認可開始時と完全に同じcallback URL |
| code_verifier | 保持したverifier |

client_secretやBasic認証を付けない。AWSアクセスキーも使用しない。成功時のJSONにはaccess_token、id_token、refresh_token、token_type、expires_inが含まれる。HTTP成功、型、Bearerのtoken_type、有効なexpires_inを検証してから保持する。IDトークンはAPIのBearerに使用しない。

## 3. API呼び出しとトークン更新

Service Workerがアクセストークンを取得し、`Authorization: Bearer <access_token>`をAPIへ付ける。取得はGET、作成はPOST、更新はPATCH、削除はDELETEとし、更新・削除ではAPIから取得した不透明なETagをIf-Matchへ付ける。ユーザー識別用のkey/ownerIdを本文で送らない。

JWTには認証されたユーザーのsub、issuer、対象アプリのclient_id、scope、期限等が含まれる。API Gatewayが署名・claims・scopeを検証し、Lambdaが検証済みissuer/subからownerIdを決定する。拡張がJWTをデコードして期限や表示情報を読むことと、APIが署名検証後に信頼することは別である。

APIを使う直前に期限を確認し、残り30秒以下なら更新する。常駐timerによる5分ごとの通信を前提にせず、worker再起動・Chromeの休止から戻っても使用直前に確認する。更新はService Worker内でsingle-flightとし、同時APIが同じrefresh tokenを重複してローテーションしない。

更新は`POST <authBase>/oauth2/token`へ、同じフォームのContent-Typeで次の項目を送る。

| フォーム項目 | 値 |
| --- | --- |
| grant_type | `refresh_token` |
| client_id | 対象環境のClient ID |
| refresh_token | 現在保持しているリフレッシュトークン |

ローテーションを有効にするため、更新成功時には新しいrefresh_tokenも返る。新しいrefresh_tokenのlocalへの保存を先に完了し、access_token・expires_in等をsessionへ保存してから待機中のAPIを再開する。local/sessionを跨ぐ原子的な保存は期待せず、途中停止時は保存済みの新しいrefresh tokenから再開する。ログアウト・接続先設定変更で進行中の更新を中断し、古い認証世代の応答を保存・利用しない。更新後のrefresh tokenの期限は元の30日間の残り期間であり、更新のたびに30日間延長されるとは扱わない。再試行猶予は10秒で、保存前の停止・通信結果不明による再試行を制限する。再開できなければ再ログインへ移る。

トークンの保存は次のとおり。

- access_tokenとその期限、認可中のstate/verifierは`chrome.storage.session`に保持する。Service Worker停止を跨いで取得でき、Chrome再起動・拡張のreload/update等では失われることを扱う。
- Chrome再起動後のログイン継続に使用するrefresh_tokenと対象環境・Client IDは`chrome.storage.local`へ保持する。local全体を`setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })`で拡張の信頼したcontextに限定し、content scriptに必要な設定等は限定したメッセージ処理で渡す。
- トークンをChrome Sync、WebページのlocalStorage、DOM、URL、ログへ置かない。content scriptやWebページへトークンを返さず、必要なリマインダー結果だけを返す。
- 再起動後にaccess_tokenがなくrefresh_tokenがある場合は、API使用前に更新する。接続先設定変更時は使用するAPI/pool/clientと保存した認証状態を照合する。

## 4. エラー・ログアウト・失効

| 状況 | クライアントの動作 |
| --- | --- |
| 認可画面の取消、state/URL不一致 | その試行を破棄し、ログイン済みとして扱わない |
| APIの401 | 一度だけ更新と再送を行う。書き込み結果が不明な通信障害とは区別する |
| APIの403 | 権限・scope・設定の問題として表示し、更新を繰り返さない |
| Cognitoの`invalid_grant`等、確定した更新不能 | 保持した認証状態を破棄し、次の明示的なログイン操作を案内する |
| Cognito/APIの通信障害・一時的な5xx | 回数制限付きbackoff。失効と断定して保持済みrefresh tokenを消さない。オフラインデータを使う |
| APIの412/428 | ETag取得・競合処理を行う。認証更新だけで解消しない |
| APIの429 | 所有者上限のRetry-AfterまたはGateway形式に従う。ログイン処理を繰り返さない |

ログアウトは現在のrefresh tokenを`POST <authBase>/oauth2/revoke`へ`client_id`と`token`というフォーム項目で送り、端末の認証状態を削除する。続いて、登録済みsign-out URLをlogout_uri、Client IDをclient_idとして`<authBase>/logout`をブラウザーの認証フローで開き、Cognitoのセッションcookieを終了する。失効要求が通信障害で未完了なら、その状態を示し、Cognito側で失効済みと表示しない。

Cognitoの無効化・失効後も発行済みアクセストークンは標準JWT Authorizerで期限まで通り得る。APIでは最大約5分の残り有効期間を許容し、毎回の失効照会を追加しない。Cognitoのcookieは1時間で、APIの5分期限と同じではない。

画像URLは別の`GET /v2/reminders/{id}/thumbnail-url`で発行し、現在の契約は発行から15分である。画像取得時にCognitoのBearerをS3へ送らない。画像URLとAPIトークンは別々に期限切れを処理し、画像の再表示用にバイト列を保存する。Cognitoの失効でS3 URLが即時失効するとは表示しない。

## 5. productionでの受け入れ確認

正確な拡張ID/callback、初回ログインと仮パスワード変更、PKCE/state、取消・不正callback、コード交換、read/write scope、5分の期限と自動更新、並行更新、worker停止・Chrome再起動、30日の期限・失効、ログアウト、画像URLの別期限、機密値をログに含めないことを確認する。検証対象の拡張版、サーバーのコミット・ZIPのSHA-256・公開version・production接続先を記録する。認証付きCRUD・画像確認は本人のアカウントと明示した合成テスト項目だけを使い、終了後にテスト項目だけをETag付きで削除する。ユーザー無効化・失効・不正callback・並行更新の失敗ケースはローカル/CIで先に模擬し、本人の利用中データ・認証状態を自動smokeで破壊しない。ログアウトや初回パスワード変更の実確認は本人の操作として扱う。

本設計更新では拡張の製品コードを変更せず、CognitoやChrome上の実ログイン試験も実施しない。サーバー単体の模擬テストと、実クライアントで確認した結果を区別する。

## 6. 一次資料

- [Chrome identity API](https://developer.chrome.com/docs/extensions/reference/api/identity)
- [Chrome拡張のcross-origin通信](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- [Chrome storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [Chrome Service Workerのライフサイクル](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Cognitoの認可エンドポイント](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html)
- [Cognitoのトークンエンドポイント](https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html)
- [Cognitoのリフレッシュトークン](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-refresh-token.html)
- [Cognitoの失効エンドポイント](https://docs.aws.amazon.com/cognito/latest/developerguide/revocation-endpoint.html)
- [Cognitoのログアウトエンドポイント](https://docs.aws.amazon.com/cognito/latest/developerguide/logout-endpoint.html)
- [Cognitoのアクセストークン](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-access-token.html)
- [API Gatewayの標準JWT Authorizer](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html)
- [RFC 7636: PKCE](https://www.rfc-editor.org/rfc/rfc7636)
