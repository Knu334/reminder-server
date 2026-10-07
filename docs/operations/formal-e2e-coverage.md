# 正式E2E 要件別検証対応表（未承認案）

作成日: 2026-10-08。[設計案](../superpowers/specs/2026-10-08-reminder-server-formal-e2e-design.md)、
[計画案](../superpowers/plans/2026-10-08-reminder-server-formal-e2e.md)。全追加ケースは**未実装・未実施**。

出典略記: S=[承認済みAWS設計](../superpowers/specs/2026-10-02-reminder-server-aws-design.md)、
V=[API v2](../api-v2.md)、C=[Chrome認証](../chrome-extension-cognito-auth.md)、
J=[清掃](cleanup.md)、M=[移行](migration.md)、R=[復旧](recovery.md)、D=[配布](deployment.md)。
既存test列のfile名は `tests/runtime/`（rt）、`tests/operations/`（op）、`tests/delivery/`（dl）、
`tools/local-e2e/floci/`（old）に対する相対path。
列内のstemにはrt/op/dlで `.test.ts`、oldで `.test.mjs` を付ける。
`old CRUD` は `authenticated-crud.test.mjs`、`rt signing` は `images.test.ts` の署名ケース、
`application mock` は `infra/application/production/tests/application.tftest.hcl` を指す。
U=単体/fake、I=決定的な結合、E=実PKCE/Gateway/ZIP API、L=実清掃/運用/ローカルIaC、A=別承認の実AWS/Chrome。
E/I/L必須=今回追加・fresh実施が必要。U/Aのみ=Eへ無理に詰めず既存回帰/未実施受け入れを保持。
「見込」はソースまたは過去記録に基づく見込みであり、今回の互換性成功ではない。
HTTP拒否の不変はSTORAGE/reminder/job/S3を指す。認証済み入力拒否のRATE消費はAPI-14に従う。
パラメーター列を持つ行は、実装時に各入力を `<ID>/<固定label>` としてinventoryへ展開する。
正常系の前提失敗で負例を検証済みにせず、not-runを残す。

## 実行順と最終結果の見方

TF-01/03でTerraform構築と設定を確認してから、E/Lケースを実行する。
正常系はHTTP応答に加え、DDBレコード・S3元bytes/job・OBSのCloudWatch結果ログを確認する。
削除直後はtombstone/retired、保護期間後の清掃はmarker/done、旧versionは60日保持という段階を分ける。
異常系もHTTP・ログと保存状態を照合する。認証拒否はGateway、APIに到達した拒否はAPI Lambdaのログを使う。
具体的な入力→出力の表は[設計案の冒頭](../superpowers/specs/2026-10-08-reminder-server-formal-e2e-design.md)にある。

## 認証

| 要件ID / 出典 | ケース | HTTP・保存状態・副作用の期待 | 分類 | 既存test | 追加E2E / 必須度 | 層 | Floci対応可否 | 未検証理由・境界 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AUTH-01 / S§4, C§2 / F05 | 公開clientのHosted UI→S256交換、state/callback、実JWKS検証 | token signature/iss/client/sub/exp、300秒、API GET200。state/code等は出力なし | 正常 | old authenticated-crud, refresh | auth実login・正の対照 / 必須 | E | 過去成功・再確認必要 | Chrome identityは別repo |
| AUTH-02 / C§2 / F05 | verifier違い・欠落、callback違い、code再利用、S256以外 | valid controlから一条件変更。token発行拒否、API保存なし。OAuth固定error分類 | 異常/境界 | old正常PKCE中心 | 各負例を独立発行codeで実施 / 必須 | E | 未確認 | 同じcodeを負例間で使い回さない。非対応は記録 |
| AUTH-03 / S§4, V認証 | JWTなし・signatureだけ改ざん | Gateway401、owner RATE/storage/job不変、前後valid GET200 | 異常 | old CRUD、rt boundaries | signatureだけ変更 / 必須 | E | 過去成功 | payload改ざんをclaims単独拒否にしない |
| AUTH-04 / S§4 | 同pool別clientの実token | valid signature/issuer/期限のままclient不一致401、保存不変 | 異常 | old CRUD、rt boundaries | sibling実PKCE / 必須 | E | 過去成功 | ID tokenのaud不一致とは別 |
| AUTH-05 / S§4, V認証 | 別issuer実tokenとissuer単独負例 | 別pool401、保存不変。期待JWKSで署名が検証可能ならissuer単独とする | 異常 | rt owner_is_issuer_sub_not_client_or_email、rejects_non_gateway_or_missing_access_claims | 別pool実PKCE + 条件単独I / 必須 | E+I | 別pool拒否見込、単独は条件付き | 別keyによる拒否をissuer単独と主張しない |
| AUTH-06 / S§4, C§1 | 正規署名tokenの実exp通過 | 直前200→expired401、期限後保存不変、refreshしたtoken200 | 境界 | rt boundaries | 300秒token aging / 必須 | E | 未確認 | payloadのexp編集は署名拒否になる。実JWTに短縮設定なし |
| AUTH-07 / S§4, V認証 | read-only→write、write-only→read、ID token | 不足scope403、保存不変。handler token_use=id単独401はIで確認 | 異常 | old CRUD, rt boundaries/api | 各scope / ID負例 / 必須 | E+I | read-only/IDは過去成功 | IDにはscopeもない。403だけでtoken_use単独証明にしない |
| AUTH-08 / S§4 | aud優先/client_id fallback、iat/nbf/sub/API/stage/claims不足 | 単独条件の401/400、rate消費なし、別issuer同subのowner hash相違 | 異常/境界 | rt boundaries、contracts | 実tokenで作れない条件は既存回帰を保持 | U+A | 単独JWT発行制御は未確認 | Gateway/JWKS cacheと実nbf等はA。偽claimsをEへ算入しない |
| AUTH-09 / S§4, C§3 | refresh rotation、read/write維持、owner不変 | OAuth200、new refresh相違、300秒、署名/系列/scope一致、renewed API200 | 正常/遷移 | old refresh9件、CRUD | production client設定で独立case / 必須 | E | 過去成功 | old refreshのSRP設定を正式fixtureへ流用しない |
| AUTH-10 / S§4, C§3 | grace内再利用・10秒後旧token拒否、期限延長なし | 内側200、外側400 invalid_grant、descendant200。retryで元deadline延長なし | 境界/異常 | old refresh、Floci Java回帰（履歴） | 実10秒 + 元deadline独立I / 必須 | E+I | 過去grace成功 | 絶対30日を実sleepで証明しない |
| AUTH-11 / S§4 | 失効、disable後の発行/refresh拒否、既存JWT | 原/descendant refresh400、disable後login/refresh拒否。既発行accessは期限まで通り得る | 異常/遷移 | old refresh失効 | 合成user・独立token family / 必須 | E | revoke過去成功、disable未確認 | 本人の本番userを操作しない。即時API失効を要求しない |
| AUTH-12 / S§4, C§3〜5 | refresh別client/欠落/不正、scope拡大なし、30日絶対期限、worker restart/single-flight/logout | OAuthinvalid_request/invalid_grant。token保存世代と期限。Chromeなしは未実施 | 異常/境界 | old refresh、Floci Java履歴 | 実OAuth負例必須、長期/拡張は層分離 | E+U+A | OAuth負例過去成功、長期・拡張不可 | 非rotation/openidなしはFloci補助回帰で製品必須から分離 |

## API・入力・一覧

| 要件ID / 出典 | ケース | HTTP・保存状態・副作用の期待 | 分類 | 既存test | 追加E2E / 必須度 | 層 | Floci対応可否 | 未検証理由・境界 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| API-01 / S§7, V / F17 | 本文なしhealth、未公開ready/v2、公開後ready | 200 healthy、503 ready/v2→200 ready。healthは依存不使用をIで証明 | 正常/遷移 | old CRUD、rt api/null-body | 独立gate fixture / 必須 | E+I | 過去成功 | 今回fresh未実施 |
| API-02 / S§7, V / F09 | 旧POST/PUT、壊れた本文付き | 410 LEGACY_API_REMOVED/replacement、旧保存/JSON解析なし、storage/rate不変 | 異常 | rt api legacy_api_is_gone | POST/PUT個別 / 必須 | E | route見込 | 実旧JSONを読まない |
| API-03 / S§7, V | finite ANY6、不許可method、unknown path | 405/Allow、既知error固定code、副作用なし。未知pathはGateway404形式 | 異常 | rt api、dl plan-guard、Floci patch回帰 | 各pathと具体CRUDの両立 / 必須 | E | method優先過去修正 | ANY削除/並べ替え禁止。unknown pathをLambda code保証しない |
| API-04 / S§7, V / B01 | 空一覧、POST/GET/PATCH/DELETE | 200空items/nullcursor→201 Location/r1→GET同body/ETag→200r2→200最小削除 | 正常 | old CRUD、rt api | DTOの全field/headers/保存照合 / 必須 | E | 過去主要経路成功 | case分割して後続not-run明示 |
| API-05 / S§4〜7 / F05 | A/B同ID、他owner GET/PATCH/DELETE/URL/list | 他owner404、B listにAなし、A保存不変。各owner同IDを独立保存可 | 異常/正常 | old CRUD、rt api/writes/images | URL含む全操作 / 必須 | E | CRUD一部過去成功 | S3 URL自体はBearer capability |
| API-06 / S§7 / F08 | 許可/未許可origin、JWTなしOPTIONS | 許可originのallow/expose/credentialsなし、OPTIONSは非認証。未許可originにallowなし | 正常/異常 | rt api/boundaries、application mock | API/S3 CORSのHTTP headers / 必須 | E | 未確認 | 未許可originを403必須にしない。ブラウザ制御はA |
| API-07 / S§7, V / F01,F09 | JSON壊れ、本文なし、空、media type/charset | 400 INVALID_JSON、415 UNSUPPORTED_MEDIA_TYPE、UTF-8 charset可。不正保存なし | 異常 | rt boundaries/api | 各body/media個別 / 必須 | E | 見込 | Gateway eventの数値body等はU |
| API-08 / S§7, V / F01,F26 | 必須欠落、unknown/readonly、空PATCH、boolean文字列 | 422 INVALID_INPUT、job/S3/metadata不変、正しい値は201/200 | 異常/境界 | rt contracts/api | field別パラメーター / 必須 | E | 見込 | 型強制変換なし |
| API-09 / S§7, V | ID1/128/129 codepoint、制御・surrogate、URL4096/4097、title0/1024/1025 | 上限内成功/超過422。LocationはIDを一度encode、永続ID同一 | 境界 | rt contracts/api/boundaries | 各長さ、Unicode/%2F/%25を実route / 必須 | E+U | encoded slash routing未確認 | 不正surrogateのJSONは単独入力で拒否。path変換はFloci限界を記録 |
| API-10 / S§7, V / B04 | 実在offset/Z、過去日時、閏日、offsetなし/不正日 | UTC同一瞬間、過去保存可、不正422、保存不変 | 正常/境界 | rt contracts | 日時パラメーター / 必須 | E | 見込 | local時刻への補完なし |
| API-11 / S§7, V / F06 | JSON2097151/2097152/2097153 bytes、UTF-8 | 前二者は他条件有効なら成功、超過413 PAYLOAD_TOO_LARGE、job/S3なし | 境界 | rt boundaries | title等制約を超えない余白で正確なbodyを作る / 必須 | E | payload通過未確認 | Gateway上限との区別。MAX_JSON_BYTES既定値を保持 |
| API-12 / S§5,7, V / F12 | limit既定20、1/50、0/51/不正、ページ順 | 200評価件数上限、無効422 INVALID_LIMIT、強いowner Query | 境界 | rt reads-rate | 51合成metadata項目・limit別 / 必須 | E | 見込 | Query命令/Scan不使用はIで補完 |
| API-13 / S§5, V | tombstoneのみの先頭page、偽/他owner/不正cursor | 空itemsでもnextCursorあり→末尾まで欠落重複なし。cursor不正422 | 境界/異常 | rt reads-rate empty_filtered_page、forged_cursor | 本物cursor交換/改ざん / 必須 | E | 見込 | 複数page snapshot保証なし |
| API-14 / S§4, V | auth拒否とinput/gate拒否のrate順、rate上限 | auth拒否RATE不変、auth済み422/503は+1。rate3fixtureの4件目429/Retry-After一致、保存なし | 境界/異常 | rt reads-rate/api | 分内window余裕・二token共有 / 必須 | E+I | 見込 | 規定120/121・次分/TTL/同時120はU/I。override実測を120並行Eと呼ばない |

## 競合・容量・保存

| 要件ID / 出典 | ケース | HTTP・保存状態・副作用の期待 | 分類 | 既存test | 追加E2E / 必須度 | 層 | Floci対応可否 | 未検証理由・境界 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| STORE-01 / S§5,7 / B02 | exact UTF-8 bodyとETag、再GET | hashからrN-hex一致、body/ETag同一、no-transform/no-store、readonly DTO | 正常 | rt contracts/api | HTTP生bytesで照合 / 必須 | E | 見込 | serializerを使って期待hashを作らない |
| STORE-02 / S§7 | missing/weak/*/list/wrong-hash/stale If-Match | 428/422/412、現在内容とSTORAGE不変 | 異常 | old CRUD、rt writes/contracts | PATCH/DELETE別、逐次stale / 必須 | E | missing/stale過去成功 | 並行競合とは別 |
| STORE-03 / S§5 / F02,B02 | 同ETag PATCH/PATCH、DELETE/DELETE、PATCH/DELETE | barrier同時送信、一成功/一拒否、revision+1、counter/job一回だけ変化。PATCH同士は412、DELETE勝者後の強いreadでは404も契約内 | 競合 | rt writes/lowered-quotas | 個別独立fixture + 同revision読取を揃えるI / 必須 | E+I | transaction実互換未確認 | sequential staleで代用しない。双方が旧activeを読んだIは敗者412 |
| STORE-04 / S§5 | 同ID同時POST、異ID同時更新、再送 | 一201/一409、異項目保持、再送で二重quotaなし | 競合/異常 | rt writes | actual DDB/counters / 必須 | E | 見込 | 無期限クライアント冪等キーは追加しない |
| STORE-05 / S§5, V | tombstone、削除後GET/再作成 | 200→404→409、本文/画像参照除去、counter減算、他項目不変 | 遷移 | old CRUD、rt writes | exact tombstone field照合 / 必須 | E | 過去成功 | Undo APIなし |
| STORE-06 / S§5,7 / F06 | itemCount2・imageBytes24の等号/超過・同時競合 | 最大内成功/増分超過413 OWNER_STORAGE_LIMIT_EXCEEDED、一括整合 | 境界/競合 | rt writes/images/lowered-quotas | 小上限専用fixture / 必須 | E | 見込 | 規定1000/128MiBとlowered cap回復はU/Iも維持 |
| STORE-07 / S§5,6 / F11,F16 | transaction before/after-response-lost、再照合失敗 | 同ClientRequestToken/next、強いreadで成功確定または503、counter二重なし、committed保護 | 障害 | rt writes/images | real adapterへ狭い送信fault / 必須 | I | 実送信+応答遮断は要実装 | ZIP Gatewayの実faultと呼ばない |

## 画像

| 要件ID / 出典 | ケース | HTTP・保存状態・副作用の期待 | 分類 | 既存test | 追加E2E / 必須度 | 層 | Floci対応可否 | 未検証理由・境界 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| IMG-01 / S§6, V | BASE64/data URL、PNG/JPEG/GIF/WebP、null/空/省略 | 201/200、元S3 bytes/MIME/length/SHA/version完全一致。DTOはmetadataのみ、DBにbytesなし | 正常 | rt images/contracts、旧直接invoke報告 | 実認証付き画像入力 / 必須 | E | 旧L一部成功・E未確認 | 変換/direct uploadなし |
| IMG-02 / S§6,7 | invalid alphabet/pad bits/padding、MIME不一致/未対応 | 422 INVALID_THUMBNAIL、pending/job/S3/counterなし | 異常 | rt images/contracts | 各独立入力 / 必須 | E | 見込 | 実画像不要 |
| IMG-03 / S§7, V | 1048575/1048576/1048577 decoded bytes | 上限内元bytes保持、超過413 THUMBNAIL_TOO_LARGE、DB mutationなし | 境界 | rt images exact_1_mib | BASE64がJSON2MiBに収まる / 必須 | E | 未確認 | transport/payload失敗は画像validatorと混同しない |
| IMG-04 / S§6, V | thumbnail URL発行とGET、再発行 | 200 no-store/ETagなし、900秒/owned pinned version、GET元bytes・Bearerなし、本体/ETag不変 | 正常 | rt images/signing、旧L報告 | 実JWT発行→元URL取得 / 必須 | E | DNS固定が必要な場合あり | URL/Host/query改変なし。取得200だけで署名強制証明にしない |
| IMG-05 / S§6 | A画像にBのURL要求、画像なし、deleted item | 404 REMINDER_NOT_FOUND/THUMBNAIL_NOT_FOUND、署名発行なし、保存不変 | 異常 | rt images | 各状態実HTTP / 必須 | E | 見込 | 既に知った署名URLの共有は別契約 |
| IMG-06 / S§6 | 差し替え、PATCH省略保持、null/空除去、DELETE | new committed/old retired、retired移行時+24h、counter差分、GET現参照version | 遷移 | rt images | actual S3/job/counter / 必須 | E | 見込 | 旧versionと発行済みURLの即時失効を保証しない |
| IMG-07 / S§6 | 画像付き二重作成でS3成功/DB拒否 | 409、元項目不変、新孤児pending/unique key、storage加算なし | 障害/競合 | rt s3_success_db_reject_leaves_pending | HTTP二重POSTの状態照合 / 必須 | E | 見込 | 本物の孤児を清掃fixtureへ繋ぐ |
| IMG-08 / S§6 | pending作成/Put/upload記録/DB失敗・unknown | 503または照合済成功、pending追跡/既commit保護、同key無条件再Putなし | 障害 | rt images/cleanup | 故障位置別独立ケース / 必須 | I | 決定的注入が必要 | 実サービス停止はしない |
| IMG-09 / S§6 | 署名改ざん・期限切れ・再取得 | 正常control成功、tamper/expired拒否を独立確認、API15分発行はIMG-04 | 異常/境界 | rt signingは構造のみ | 短期限S3control + bad signature / 互換性調査必須 | L+A | 条件付き、Floci認証検査default=false | 不許可controlが通れば署名強制未検証。15分実expiry/短期credentialはA |

## 清掃

| 要件ID / 出典 | ケース | HTTP・保存状態・副作用の期待 | 分類 | 既存test | 追加E2E / 必須度 | 層 | Floci対応可否 | 未検証理由・境界 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CLEAN-01 / S§6, J | 未公開、公開、eventへのkey/owner injection | unpublished skipped/no mutation/no heartbeat、公開は実handler、任意event拒否 | 正常/異常 | rt cleanup/api | same ZIP cleanup alias invoke / 必須 | L | 旧L一部成功 | HTTP APIの認証検証ではない |
| CLEAN-02 / S§5,6 | pending/retiredの24h前/後、retired時刻起点 | 前側保持、後側deleting→done、markerだけ追加、元version保持 | 境界/遷移 | rt jobs/cleanup | 合成時刻・索引全属性一致 / 必須 | L+I | 見込 | 実24h待ちなし。exact等号はI |
| CLEAN-03 / S§5,6 | active/expired deleting lease20分、version記録前pending | active保持/expired再claim→done、lease owner条件、未記録key照合 | 境界/遷移 | rt jobs/cleanup | 合成lease seed / 必須 | L+I | 見込 | exact20分境界/claim raceはI |
| CLEAN-04 / S§5,6 | committed/done索引除外、stale GSI/commit競合 | 参照中committed画像保持、古いGSI候補のstrong conditionでskip | 異常/競合 | rt jobs gsi_stale、cleanup stale_index | 実committed保護 + deterministic stale / 必須 | L+I | 実GSI遅延制御不可 | 壊れたjobを正規API状態遷移として扱わない |
| CLEAN-05 / S§5,6 | HEAD version/checksum違い、既marker/不存在 | 不一致は削除/完了しない。marker/不存在はdoneへ収束、永久削除なし | 異常/遷移 | rt cleanup/images | 合成version mismatch / 必須 | L | 旧marker一部成功 | fixture回収の永久削除とは別role |
| CLEAN-06 / S§5 | 同shard51件、page50、12partition巡回・次回reset | 全候補done、checkpointにGSI属性なし、再invokeで漏れ/重複markerなし | 境界/遷移 | rt jobs/cleanup | 合成UUIDをshardへ選別 / 必須 | L+I | 見込 | 実Query順を計測できない部分はI |
| CLEAN-07 / S§5,6 | page途中停止/再開、GSI後日反映 | page開始cursor保持、未処理を飛ばさず再取得、次runで遅延候補取得 | 障害/遷移 | rt cleanup partial_page | requestHandler/depsで決定的中断 / 必須 | I | 実runtime時間制御は不可 | Lambda timeoutを無理に660秒待たない |
| CLEAN-08 / S§6, J | 10000候補/5000delete/600秒/残り60秒/並行4 | 上限で新規停止、in-flight settle/checkpoint、incomplete、上限超過なし | 境界 | rt cleanup limits_candidates | 既存回帰 + 実adapter小inventory停止 / 必須 | I+U | 大量実Eは採らない | 正規handlerへtest cap/clockを追加しない |
| CLEAN-09 / S§6, J | delete結果不明、checkpoint/metric失敗、再invoke | marker HEAD照合、done収束、失敗FunctionError、checkpoint保持、heartbeatは成功後のみ | 障害 | rt cleanup | deterministic fault + 実2回invoke / 必須 | I+L | 一部見込 | async受付を処理成功としない |

## 運用・IaC・診断

| 要件ID / 出典 | ケース | HTTP・保存状態・副作用の期待 | 分類 | 既存test | 追加E2E / 必須度 | 層 | Floci対応可否 | 未検証理由・境界 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OPS-01 / S§8, M / B03 | 合成JSON、特殊key/空owner、import/verify/publish | unpublished API503、全field/bytes/counter照合後publish→ready200、created保持/r1 | 正常/遷移 | op legacy/migration | real local adapters、明示client注入 / 必須 | L | 未確認 | 本番JSON/CLI default credentials chainを使用しない |
| OPS-02 / S§8, M | 中断/再開、入力hash変更、checksum不一致 | gatefalse、変更run拒否、二重items/versions/counterなし、corruptでpublish不可 | 異常/障害 | op migration transport回帰 | exact input rerun + deterministic fault / 必須 | L+I | 見込 | 実源ファイルhash禁止。合成生成物だけ |
| OPS-03 / S§8, R | 合成復旧3table、read-only検証、非current画像保全・rerun | source不変、target未公開、新unique current key元bytes、revision/created/counter維持 | 正常/遷移 | op recovery | 実local adapters / 必須 | L | 未確認 | PITR実行/APIや本番切替ではない |
| OPS-04 / S§8, R | recreated sub、explicit remap、target collision/bad counter | 自動対応なし、明示mapのみ、bad stateでreadyToSwitch=false、Cognito復元false | 異常 | op recovery | local単独ケース / 必須 | L+I | 見込 | Cognito password/sessionや35日PITRはA |
| OPS-05 / S§10, D / F19,B06 | current build/package→S3 ZIP→API/cleanup | local digest=manifest=S3 pinned checksum=両Lambda CodeSha256/alias選択version | 正常/異常 | dl bundle/artifact/release、旧L報告 | stale/tampered control + actual register / 必須 | L+E | 一部過去成功 | ZIP古い固定hash禁止、dirty build入力digestを併記 |
| OPS-06 / S§6, J | daily configとowned one-time起動 | cron03UTC/OFF/DISABLED/retry2/age3600/cleanup alias read-back。at→job変化 | 正常/遷移 | application mock | 設定はTF-03必須、起動実probeは互換性調査必須 | L+A | sourceにEvent invokeあり、live未確認 | source記載は稼働binary証明ではない。日次運転/配信保証はA |
| TF-01 / S§9〜11, handoff§8 | E2E local root apply→current ZIP/Gateway/save→destroy | Terraform1.16.5/provider6.67.0、同route/scope/schema/hash、動作assert、owned資源のみ回収 | 正常/互換性 | dl infra-check/plan-guardはmock | 構築成功・destroy / 必須 | L | 未確認、必要APIごと判定 | production3root/OIDC/remote state full applyは対象外 |
| TF-02 / handoff安全境界 | apply途中失敗、destroy失敗、endpoint漏れ | default AWS送信前拒否、ローカルstateだけ、partial owned inventory回収、cleanup別報告 | 障害/異常 | old transport、dl private-command | isolated driver負例 / 必須 | I+L | driverを新規実装 | 本番state/plan/inputsは存在確認以上の対象にしない |
| TF-03 / S§4〜6,9〜13 | apply後の構築設定read-back、差異control | 3table/GSI/TTL/PITR35日、S3 versioning/暗号化/公開防止/CORS/旧version60日、認証/16route/alias/同一ZIP、Lambda実行設定、3log group30日、daily Scheduler一致 | 正常/異常 | dl infra mock | 実read-back gate / 必須 | L | 必要API未確認 | 不足設定を省略してpassにしない。本番との差分を列挙 |
| OBS-01 / S§13 / F10 | APIの成功/拒否/503/初期化失敗、cold/warm | 1 invocation 1件、operation/status/code/IDs/duration、安全なJSON512bytes以内、HTTP契約不変 | 正常/異常 | shared loggingのみ、API結果ログなし | 製品結果ログ追加・handler境界capture / 必須 | U+I | APIコード追加後に確認 | captureはCloudWatch配信証拠ではない |
| OBS-02 / S§13 | CRUD成功、入力拒否、Gateway認証拒否 | APIとGatewayのrequestId/status照合、API error codeはHTTPと一致。認証拒否はGatewayのみ | 正常/異常 | Gateway access log設定のみ | owned Logs実読取、60秒poll / 必須 | E | 配信未確認 | raw console/手動PutLogEventsで代用しない |
| OBS-03 / S§6,13, J | 清掃Lambda成功/不完全結果、件数照合 | Lambda request ID、cleanup/status/処理件数と実保存状態一致 | 正常/障害 | cleanup構造化ログ既存 | 実成功配信 + 故障時境界capture / 必須 | L+I | 配信未確認 | 決定的故障Iのcaptureを実配信扱いにしない |
| OBS-04 / S§13,15 | logs reader/page/poll、canary、長いID | 別run/別serviceは不一致、poll有期限、秘密と生ログの保存なし、追加1KiB/呼び出しの予算 | 異常/費用 | rt logging安全化 | logger/observer負例 / 必須 | U+I | 実装可能 | 1KiBは費用仮定、AWS請求量の上限保証ではない |
| SAFE-01 / S§13, handoff | 未認証外host/redirect/DNS drift、ambient AWS設定 | local pinned IPv4以外拒否、profile/metadata/default endpoint参照0、Host保持 | 異常 | old local-transport2件 | transport/harness単独回帰 / 必須 | I | 実装可能 | 権限/FW変更をテスト成功条件にしない |
| SAFE-02 / S§13, handoff | fixture各段階失敗、cleanup一action失敗/割込 | 後続dependent not-run、独立case継続、全cleanup試行、errors/leaks別、exit非0 | 障害 | old transport/CRUD finally | resource manifestと結果registry / 必須 | I+E+L | 実装可能 | SIGKILLはfinally保証不能、owned手動回収手順 |
| SAFE-03 / S§13 / F10 | assertion diff/SDK例外/子process/TF診断にcanary | token/code/cookie/password/URL/credential/body/envを保存/表示しない、固定assert名とcounts | 異常 | rt never_logs_secrets、dl private-command | harness failure canary / 必須 | I | 実装可能 | owned Logs読取・配信はOBS必須。本番ログ全体/IAMはA |
| SAFE-04 / S§15 / F18,F23〜24 | IAM/TLS/timeout/freeze/concurrency、AWS alarm/GHA/PITR/Chrome | 実受け入れ未実施を維持。mock/Flociから同等性/性能を推定しない | 対象外 | dl infra/workflows、op recovery | 既存回帰と未検証記録 | U+A | 本番同等性不可 | 別承認、拡張ソースなし、GHA起動禁止 |

## 受け入れ集計規則

行数やold CRUD内チェック数を新case件数に足さない。実装registryの各caseに上記ID・層・必須度・
source・期待assertを持たせ、日本語結果の全case inventoryと一対一で照合する。
Uだけの成功でE/L未実施を埋めない。互換性調査必須のIMG-09/OPS-06起動経路は、
実際の採否・失敗probe・制限が記録されれば調査完了、未確認のまま除外しない。
TF-01/03・OBS実配信・E/L必須をFlociが阻害する場合は正式E2E未完了とする。Terraform構築失敗時は依存E/Lをnot-runとし、SDK構築を成功の代替にしない。
rate、容量、cleanup上限を小fixtureで実施した値と、規定値のU/I証拠を別々に記録する。
