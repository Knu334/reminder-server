# 正式E2E 実施結果（2026-10-10）

**判定: 正式E2Eはliveの実行としては未完了である。** 最新の全suite実行（e2e-4e5b822a、refresh.7）は268件中241件が合格し、失敗は0件、24件が未実行、3件が未対応だった。完了と言えない理由は次の2点である。

1. layer Iの24件は、live実行ではnot-run（implementation-pending）のまま残る。offlineの試験（`npm run test:integration:e2e`）で実施し、対応を下の一覧に示した。liveの合格には数えない。このため `complete` は偽のままである。
2. 次の3件は、Flociの未対応を測定した結果で、互換性調査としては完了だが、各機能の動作確認はできていない。OBS-04（Gatewayのaccess log配信）、AUTH-11のhosted `/oauth2/revoke`、IMG-09（S3の署名・期限の強制）。

以前の実行（e2e-90d3b042、refresh.6）ではAPI-09/id-percent（`%25` を含むID）が失敗していた。原因はFlociのhost filter後の二重decodeで、refresh.7が修正した。refresh.7の実行ではAPI-09の全21件が合格した。

この文書の数値は、今回の実行結果だけである。過去の件数（旧337件など）や旧E2Eの結果は流用していない。

## 実行環境と入力

| 項目 | 値 |
| --- | --- |
| 実施日（UTC） | 2026-10-10。全suite実行は17:18:34〜17:32:12（821秒）。以前のrefresh.6の実行は同日10:15:29〜10:29:22（833秒） |
| HEAD | 6871291（`test: pin patched Floci refresh.7 emulator`）。以前の実行は6af5288 |
| 作業ツリー | `src/api/event.ts` が未commitの変更を含む（ユーザーのnull-body修正）。run時のZIPに含まれる。`tests/runtime/api.test.ts`、`tests/runtime/boundaries.test.ts` も未commit |
| Floci | `floci-local:2.2.0-refresh.7-native`（health `2.2.0-local-refresh.7-native`）。以前の実行はrefresh.6 |
| ツール | Node 24.21.0、npm 11.11.1、Python 3.13.16、Terraform 1.16.5、provider 6.67.0 |
| ZIP（両runで同一） | sha256（hex）`8e6dcef8710dc82aa266ba065daa5e9749a1c8f22705e9fda35e310a5ab61bb1`、1,388,430 bytes。run直前の現行buildから生成 |
| 入力digest（ZIPのbuild入力） | `f0ec15d8ea092c05388b5ee776c9d2b9766d538dd094a9d0441e6693ea46dbda` |
| 本番公開sourceのdigest | `4c903d682127bfeb11635a8057ae8afcf2165d60e81969f94c55a206922df165` |
| 変換後digest（e2e-4e5b822a） | `f3bf31acf32963c5da69eff28887b2f5df7058eba8fc957e946fb682e430ebfb`。runごとの所有名を含むため、runにより変わる（e2e-90d3b042は `0bea0d53c68c34429cae0e9c32247278fcc5fc96983797babf8b8714474db3aa`） |
| 変換の差分区分 | validation 2件（owned issuerとauth base URLのowned-url-validation）、接続の生成設定（providerのendpointと認証情報、platform output 2件）、隔離（local backend）。本番の `.tf`・lock・resource addressの変更は0 |

APIとcleanup Lambdaの実CodeSha256は、TF-03/settings（pass）がZIPのdigestと突き合わせた。値そのものはこの文書に写していない。

## 全suiteの結果

run ID: `e2e-4e5b822a-19de-46c4-8f1e-bbc3b27d8bc6`、コマンド `npm run test:e2e:floci`、exit 1、821秒（約13.7分）。期限は実行75分と回収15分である。exit 1の理由はlayer Iのnot-runで、failは0件である。

| suite | pass | fail | not-run | unsupported | case時間の合計 |
| --- | --- | --- | --- | --- | --- |
| harness | 0 | 0 | 3 | 0 | 0秒 |
| terraform | 1 | 0 | 1 | 0 | 128秒（構築） |
| fixture | 4 | 0 | 0 | 1 | 61秒 |
| auth | 11 | 0 | 2 | 1 | 303秒（実トークン期限の待ちを含む） |
| api | 140 | 0 | 0 | 0 | 13秒 |
| storage | 23 | 0 | 8 | 0 | 2秒 |
| images | 33 | 0 | 1 | 1 | 2秒 |
| cleanup | 15 | 0 | 6 | 0 | 2秒 |
| operations | 8 | 0 | 3 | 0 | 73秒 |
| logging | 4 | 0 | 0 | 0 | 1秒 |
| scheduler | 2 | 0 | 0 | 0 | 0秒 |
| 合計 | 241 | 0 | 24 | 3 | |

回収は18件を試行して18件成功、errors 0、leaks 0。独立した読み取りで、所有リソース83件が全て不在だった（存在0、未確認0）。

### 以前の実行との比較

| run | Floci | HEAD | 秒 | pass / fail / not-run / unsupported |
| --- | --- | --- | --- | --- |
| e2e-4e5b822a（主） | refresh.7 | 6871291 | 821 | 241 / 0 / 24 / 3 |
| e2e-90d3b042 | refresh.6 | 6af5288 | 833 | 240 / 1 / 24 / 3（失敗はAPI-09/id-percent） |
| e2e-f4d81679 | refresh.5 | 51e2c5e | 816 | 239 / 2 / 24 / 3（失敗はAPI-09のid-percentとid-slash） |

loggingとschedulerは、単独のrun（e2e-a90fb040、e2e-94e3b315）でも合格した。実測の全体は約12〜14分で、実測前の見積り22〜65分より短い。

## offlineの検証（2026-10-10、HEAD 6af5288に本タスクの変更を加えた状態）

| 検証 | コマンド | 結果 |
| --- | --- | --- |
| typecheck | `npm run typecheck` | 成功（修正後。coverage.test.tsの一時的な型誤りは修正した） |
| lint | `npm run lint` | 成功（既存のwarningは[調査記録](formal-e2e-research.md)に記録済み） |
| build / package / verify:zip | `npm run build` ほか | 成功。全suiteの前にZIPを再生成して検証した |
| Node全suite | `npm test` | runtime 188/188、operations 74/74、delivery 97/97 |
| Python packaging | `npm run test:packaging` | 成功 |
| runtime / full audit | `npm run audit:runtime`、`npm run audit:all` | どちらも0 vulnerabilities |
| E2E offline（integration） | `npm run test:integration:e2e` | 161/161（対応表照合の `coverage.test.ts` 9件を含む） |
| E2E case code（simulation） | `npx tsx --test tests/e2e/floci/*.test.ts` | 107/107 |
| infra:check | `npm run infra:check` | **失敗**。このsandboxでTerraform initがAWS provider v6.67.0のinstallに失敗した（exit 1）。3rootの検証成功には数えない。同じ3 rootの構築はlive runで成功している |

Floci側のJava回帰試験は、Temurin JDK 25.0.1+8と `./mvnw` で実行した（上流17c99047にパッチを適用したclone）。refresh.6のパッチでは、パッチの回帰11クラスが299件中1件失敗した（`100%25` が200ではなく500。診断どおりの失敗）。refresh.7では同じ11クラスが300/300合格し、apigateway・apigatewayv2・coreのpackageは1853件で失敗0（skip 6）、checkstyle:checkも成功した。上流のDocker依存のLambda・WebSocket試験は開発コンテナで動かせず、`./mvnw test` の全件実行はしていない。

## 観測と判断の記録

- **API-09/id-percent**: refresh.6では、作成は201でも `Location` による読み戻しがFlociの500になり、失敗した（e2e-90d3b042）。host filterが保存したpathを後続の `@PreMatching` filterが `UriInfo.getPath()` で再度decodeし、単独の `%` で例外になるためである。refresh.7はhost filterで `%` を `%25` に直し、e2e-4e5b822aでid-percent、id-slash、id-percent2fを含むAPI-09の全21件が合格した。
- **rate消費とgateの順**: 認証済みで、入力検証や未公開gateに拒否された要求は、rateを1消費する。rateの確認は、gateと意味検査（`src/api/event.ts` 51行付近の注記）より前にあるためである。API-01とAPI-14が確認する。認証に拒否された要求はrateを消費しない。
- **API-14**: 対応表のAPI-14は `API-14/rate-boundary-seeded` に対応する。合成のcount 119から実GETの200、次の429とRetry-Afterの一致を確認した。121回の送信や120並行ではない。
- **AUTH-11**: 失効はRevokeToken APIで行い、原tokenとdescendantの拒否を確認した。hosted `/oauth2/revoke` は、Flociにrouteが無く、S3のcatch-all 400が返るため、別caseでunsupportedとした。S3のInvalidArgument署名を持つ400だけをunsupportedとし、他の400はfailとする。
- **CLEAN-01**: 開始・skip・終了のログとFunctionErrorは実Lambdaで確認した。heartbeatの不在は、L（実Lambda）ではCloudWatchを読んでおらず、tests/runtimeとcleanup-resume.test.tsのU/I証拠である。
- **清掃ログの「60秒以内」**: 最後の入力から60.5秒までの観測窓と、その後の有界な完了pollを指す。最悪で約120.5秒になる。ハードな60秒の打ち切りではない。走査が途中で打ち切られた場合は、不在をpassにせずfailにする。
- **S3 policy**: 設定gateはDeny policyの保持（policy-present）を読み戻した。FlociがSecureTransportを評価するか、署名・期限を強制するかは未検証（enforcement-unverified）である。HTTPの成功を強制の証拠にしない。
- **OBS-04**: stageのaccessLogSettingsは読み戻せたが、gateway log groupのeventは0件だった。Gateway配信はunsupported。API結果ログと清掃ログのCloudWatch配信は、必須のcaseとして合格した。
- **OPS-06**: run専用のone-time Scheduleを実際に起動し、job done、delete marker、checkpoint、清掃ログの4つが揃った。日次Scheduleは読み取りだけで、変更していない。
- OPS-05とTF-04は、専用のcaseを持たない。TF-01/applyの構築、TF-03/settingsのZIP読み戻し、変換差分の記録と、`tests/integration/formal-e2e/terraform-driver.test.ts` などのoffline試験で確認した。これは対応表の行と登録caseが一対一でない箇所である。

## review・rulingsの要約

Task 1〜11の各taskはreview済みで、live中に見つかったharnessの欠陥は修正し、再reviewした。主なrulingは、Floci patch（refresh.2〜6）のユーザー承認、`-refresh=false` を回収時だけに限る判断、S3 Controlの限定relay、観測失敗と走査の途中打ち切りをfailとする判断である。全文は台帳（`.superpowers/sdd/2026-10-08-reminder-server-formal-e2e/progress.md`）にある。台帳はgit管理外の作業記録である。
このtaskの後に、controllerが全task範囲の最終reviewを行う。

## 全case一覧と結果

判定の基準は run `e2e-4e5b822a-19de-46c4-8f1e-bbc3b27d8bc6` である。layer Iは、liveで実行されないため、offline試験fileを示す。

全268件: pass 241 / fail 0 / not-run 24 / unsupported 3

| ID | 層 | suite | 区分 | 結果 | 根拠 |
| --- | --- | --- | --- | --- | --- |
| `SAFE-01/transport` | I | harness | behavior | not-run | liveでは未実行（implementation-pending）。offline: `tests/integration/formal-e2e/harness.test.ts` |
| `SAFE-02/inventory` | I | harness | behavior | not-run | liveでは未実行（implementation-pending）。offline: `tests/integration/formal-e2e/harness.test.ts` |
| `SAFE-03/redaction` | I | harness | behavior | not-run | liveでは未実行（implementation-pending）。offline: `tests/integration/formal-e2e/harness.test.ts` |
| `TF-02/driver-isolation` | I | terraform | behavior | not-run | liveでは未実行（implementation-pending）。offline: `tests/integration/formal-e2e/terraform-driver.test.ts` |
| `TF-01/apply` | L | terraform | behavior | pass | e2e-4e5b822a |
| `TF-03/settings` | L | fixture | behavior | pass | e2e-4e5b822a |
| `OBS-02/smoke` | E | fixture | behavior | pass | e2e-4e5b822a |
| `OBS-03/gateway-refusal` | E | fixture | behavior | pass | e2e-4e5b822a |
| `OBS-04/gateway-delivery` | L | fixture | compatibility | unsupported | gateway-delivery-unsupported（gateway log groupのeventが0件） |
| `TF-03/settings-final` | L | fixture | behavior | pass | e2e-4e5b822a |
| `AUTH-01/pkce-login` | E | auth | behavior | pass | e2e-4e5b822a |
| `AUTH-02/pkce-negatives` | E | auth | behavior | pass | e2e-4e5b822a |
| `AUTH-03/jwt-signature` | E | auth | behavior | pass | e2e-4e5b822a |
| `AUTH-04/sibling-client` | E | auth | behavior | pass | e2e-4e5b822a |
| `AUTH-05/foreign-issuer` | E | auth | behavior | pass | e2e-4e5b822a |
| `AUTH-07/scope-and-id-token` | E | auth | behavior | pass | e2e-4e5b822a |
| `AUTH-09/refresh-rotation` | E | auth | behavior | pass | e2e-4e5b822a |
| `AUTH-10/rotation-grace` | E | auth | behavior | pass | e2e-4e5b822a |
| `AUTH-11/revoke-disable` | E | auth | behavior | pass | e2e-4e5b822a |
| `AUTH-12/refresh-negatives` | E | auth | behavior | pass | e2e-4e5b822a |
| `AUTH-11/hosted-revoke-endpoint` | L | auth | compatibility | unsupported | hosted-revoke-unsupported（Flociにroute無し、S3 catch-all 400） |
| `AUTH-06/token-expiry` | E | auth | behavior | pass | e2e-4e5b822a |
| `AUTH-05/issuer-only` | I | auth | behavior | not-run | liveでは未実行（implementation-pending）。offline: `tests/integration/formal-e2e/auth-claims.test.ts` |
| `AUTH-07/token-use-only` | I | auth | behavior | not-run | liveでは未実行（implementation-pending）。offline: `tests/integration/formal-e2e/auth-claims.test.ts` |
| `API-01/gate-transition` | E | api | behavior | pass | e2e-4e5b822a |
| `API-02/legacy-post` | E | api | behavior | pass | e2e-4e5b822a |
| `API-02/legacy-put` | E | api | behavior | pass | e2e-4e5b822a |
| `API-03/healthz-delete` | E | api | behavior | pass | e2e-4e5b822a |
| `API-03/readyz-post` | E | api | behavior | pass | e2e-4e5b822a |
| `API-03/legacy-get` | E | api | behavior | pass | e2e-4e5b822a |
| `API-03/list-delete` | E | api | behavior | pass | e2e-4e5b822a |
| `API-03/item-post` | E | api | behavior | pass | e2e-4e5b822a |
| `API-03/thumbnail-post` | E | api | behavior | pass | e2e-4e5b822a |
| `API-03/unknown-root-segment` | E | api | behavior | pass | e2e-4e5b822a |
| `API-03/unknown-extra-item-segment` | E | api | behavior | pass | e2e-4e5b822a |
| `API-03/unknown-v2-sibling` | E | api | behavior | pass | e2e-4e5b822a |
| `API-04/empty-list` | E | api | behavior | pass | e2e-4e5b822a |
| `API-04/create` | E | api | behavior | pass | e2e-4e5b822a |
| `API-04/get` | E | api | behavior | pass | e2e-4e5b822a |
| `API-04/patch` | E | api | behavior | pass | e2e-4e5b822a |
| `API-04/delete` | E | api | behavior | pass | e2e-4e5b822a |
| `API-12/seed-51` | E | api | behavior | pass | e2e-4e5b822a |
| `API-12/default` | E | api | behavior | pass | e2e-4e5b822a |
| `API-12/limit-1` | E | api | behavior | pass | e2e-4e5b822a |
| `API-12/limit-20` | E | api | behavior | pass | e2e-4e5b822a |
| `API-12/limit-50` | E | api | behavior | pass | e2e-4e5b822a |
| `API-12/limit-0` | E | api | behavior | pass | e2e-4e5b822a |
| `API-12/limit-51` | E | api | behavior | pass | e2e-4e5b822a |
| `API-12/limit-abc` | E | api | behavior | pass | e2e-4e5b822a |
| `API-12/limit-negative` | E | api | behavior | pass | e2e-4e5b822a |
| `API-12/limit-decimal` | E | api | behavior | pass | e2e-4e5b822a |
| `API-12/limit-hex` | E | api | behavior | pass | e2e-4e5b822a |
| `API-12/walk-limit-20` | E | api | behavior | pass | e2e-4e5b822a |
| `API-12/walk-limit-7` | E | api | behavior | pass | e2e-4e5b822a |
| `API-13/tombstone-seed` | E | api | behavior | pass | e2e-4e5b822a |
| `API-13/tombstone-head-limit-3` | E | api | behavior | pass | e2e-4e5b822a |
| `API-13/tombstone-head-limit-1` | E | api | behavior | pass | e2e-4e5b822a |
| `API-13/forged-owner` | E | api | behavior | pass | e2e-4e5b822a |
| `API-13/forged-version` | E | api | behavior | pass | e2e-4e5b822a |
| `API-13/forged-extra-field` | E | api | behavior | pass | e2e-4e5b822a |
| `API-13/forged-lastid-control` | E | api | behavior | pass | e2e-4e5b822a |
| `API-13/not-base64url` | E | api | behavior | pass | e2e-4e5b822a |
| `API-13/not-json` | E | api | behavior | pass | e2e-4e5b822a |
| `API-13/oversize` | E | api | behavior | pass | e2e-4e5b822a |
| `API-13/other-owner-cursor` | E | api | behavior | pass | e2e-4e5b822a |
| `API-05/seed` | E | api | behavior | pass | e2e-4e5b822a |
| `API-05/other-owner-get` | E | api | behavior | pass | e2e-4e5b822a |
| `API-05/other-owner-patch` | E | api | behavior | pass | e2e-4e5b822a |
| `API-05/other-owner-delete` | E | api | behavior | pass | e2e-4e5b822a |
| `API-05/other-owner-thumbnail` | E | api | behavior | pass | e2e-4e5b822a |
| `API-05/other-owner-list` | E | api | behavior | pass | e2e-4e5b822a |
| `API-05/same-id-independent` | E | api | behavior | pass | e2e-4e5b822a |
| `API-06/allowed-origin-preflight` | E | api | behavior | pass | e2e-4e5b822a |
| `API-06/disallowed-origin-preflight` | E | api | behavior | pass | e2e-4e5b822a |
| `API-06/allowed-origin-actual` | E | api | behavior | pass | e2e-4e5b822a |
| `API-06/disallowed-origin-actual` | E | api | behavior | pass | e2e-4e5b822a |
| `API-06/s3-allowed-origin-preflight` | E | api | behavior | pass | e2e-4e5b822a |
| `API-06/s3-disallowed-origin-preflight` | E | api | behavior | pass | e2e-4e5b822a |
| `API-07/invalid-json` | E | api | behavior | pass | e2e-4e5b822a |
| `API-07/empty-body` | E | api | behavior | pass | e2e-4e5b822a |
| `API-07/no-body` | E | api | behavior | pass | e2e-4e5b822a |
| `API-07/plain-text-body` | E | api | behavior | pass | e2e-4e5b822a |
| `API-07/media-text-plain` | E | api | behavior | pass | e2e-4e5b822a |
| `API-07/media-form` | E | api | behavior | pass | e2e-4e5b822a |
| `API-07/media-missing` | E | api | behavior | pass | e2e-4e5b822a |
| `API-07/media-charset-latin1` | E | api | behavior | pass | e2e-4e5b822a |
| `API-07/media-json-suffix` | E | api | behavior | pass | e2e-4e5b822a |
| `API-07/media-charset-utf8` | E | api | behavior | pass | e2e-4e5b822a |
| `API-07/media-charset-mixed-case` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/missing-id` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/missing-url` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/missing-title` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/missing-reminderTime` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/missing-autoOpen` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/missing-webPush` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/missing-hidden` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/unknown-field` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/readonly-revision` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/readonly-createdAt` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/readonly-updatedAt` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/owner-field` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/boolean-string-autoOpen` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/boolean-number-webPush` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/boolean-string-hidden` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/type-url-number` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/type-title-null` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/type-id-number` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/type-thumbnail-number` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/url-ftp` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/url-no-scheme` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/body-array` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/body-null` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/body-number` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/patch-empty` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/patch-id-field` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/patch-unknown-field` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/patch-readonly-revision` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/patch-boolean-string` | E | api | behavior | pass | e2e-4e5b822a |
| `API-08/patch-title-null` | E | api | behavior | pass | e2e-4e5b822a |
| `API-09/path-id-129` | E | api | behavior | pass | e2e-4e5b822a |
| `API-09/id-129` | E | api | behavior | pass | e2e-4e5b822a |
| `API-09/id-129-astral` | E | api | behavior | pass | e2e-4e5b822a |
| `API-09/id-empty` | E | api | behavior | pass | e2e-4e5b822a |
| `API-09/id-control` | E | api | behavior | pass | e2e-4e5b822a |
| `API-09/id-lone-surrogate` | E | api | behavior | pass | e2e-4e5b822a |
| `API-09/url-4097` | E | api | behavior | pass | e2e-4e5b822a |
| `API-09/title-1025` | E | api | behavior | pass | e2e-4e5b822a |
| `API-09/title-1025-astral` | E | api | behavior | pass | e2e-4e5b822a |
| `API-09/id-1` | E | api | behavior | pass | e2e-4e5b822a |
| `API-09/id-128` | E | api | behavior | pass | e2e-4e5b822a |
| `API-09/id-128-astral` | E | api | behavior | pass | e2e-4e5b822a |
| `API-09/id-unicode` | E | api | behavior | pass | e2e-4e5b822a |
| `API-09/id-percent2f` | E | api | behavior | pass | e2e-4e5b822a |
| `API-09/id-percent` | E | api | behavior | pass | e2e-4e5b822a |
| `API-09/id-slash` | E | api | behavior | pass | e2e-4e5b822a |
| `API-09/id-space` | E | api | behavior | pass | e2e-4e5b822a |
| `API-09/url-4096` | E | api | behavior | pass | e2e-4e5b822a |
| `API-09/title-0` | E | api | behavior | pass | e2e-4e5b822a |
| `API-09/title-1024` | E | api | behavior | pass | e2e-4e5b822a |
| `API-09/title-1024-astral` | E | api | behavior | pass | e2e-4e5b822a |
| `API-10/no-offset` | E | api | behavior | pass | e2e-4e5b822a |
| `API-10/leap-day-invalid` | E | api | behavior | pass | e2e-4e5b822a |
| `API-10/month-13` | E | api | behavior | pass | e2e-4e5b822a |
| `API-10/april-31` | E | api | behavior | pass | e2e-4e5b822a |
| `API-10/hour-24` | E | api | behavior | pass | e2e-4e5b822a |
| `API-10/offset-hour-24` | E | api | behavior | pass | e2e-4e5b822a |
| `API-10/date-only` | E | api | behavior | pass | e2e-4e5b822a |
| `API-10/space-separator` | E | api | behavior | pass | e2e-4e5b822a |
| `API-10/offset-one-digit` | E | api | behavior | pass | e2e-4e5b822a |
| `API-10/not-a-string` | E | api | behavior | pass | e2e-4e5b822a |
| `API-10/offset-plus9` | E | api | behavior | pass | e2e-4e5b822a |
| `API-10/z-form` | E | api | behavior | pass | e2e-4e5b822a |
| `API-10/offset-minus-0530` | E | api | behavior | pass | e2e-4e5b822a |
| `API-10/leap-day` | E | api | behavior | pass | e2e-4e5b822a |
| `API-10/past` | E | api | behavior | pass | e2e-4e5b822a |
| `API-10/fraction` | E | api | behavior | pass | e2e-4e5b822a |
| `API-10/year-boundary-offset` | E | api | behavior | pass | e2e-4e5b822a |
| `API-11/body-2097151` | E | api | behavior | pass | e2e-4e5b822a |
| `API-11/body-2097152` | E | api | behavior | pass | e2e-4e5b822a |
| `API-11/body-2097152-utf8` | E | api | behavior | pass | e2e-4e5b822a |
| `API-11/body-2097153` | E | api | behavior | pass | e2e-4e5b822a |
| `API-14/auth-refusal-rate-unchanged` | E | api | behavior | pass | e2e-4e5b822a |
| `API-14/input-422-rate-plus-one` | E | api | behavior | pass | e2e-4e5b822a |
| `API-14/unpublished-503-rate-plus-one` | E | api | behavior | pass | e2e-4e5b822a |
| `STORE-01/exact-etag-and-headers` | E | storage | behavior | pass | e2e-4e5b822a |
| `STORE-02/patch-missing-if-match` | E | storage | behavior | pass | e2e-4e5b822a |
| `STORE-02/patch-weak-if-match` | E | storage | behavior | pass | e2e-4e5b822a |
| `STORE-02/patch-star-if-match` | E | storage | behavior | pass | e2e-4e5b822a |
| `STORE-02/patch-list-if-match` | E | storage | behavior | pass | e2e-4e5b822a |
| `STORE-02/patch-same-revision-other-hash` | E | storage | behavior | pass | e2e-4e5b822a |
| `STORE-02/patch-sequential-stale` | E | storage | behavior | pass | e2e-4e5b822a |
| `STORE-02/delete-missing-if-match` | E | storage | behavior | pass | e2e-4e5b822a |
| `STORE-02/delete-weak-if-match` | E | storage | behavior | pass | e2e-4e5b822a |
| `STORE-02/delete-star-if-match` | E | storage | behavior | pass | e2e-4e5b822a |
| `STORE-02/delete-list-if-match` | E | storage | behavior | pass | e2e-4e5b822a |
| `STORE-02/delete-same-revision-other-hash` | E | storage | behavior | pass | e2e-4e5b822a |
| `STORE-02/delete-sequential-stale` | E | storage | behavior | pass | e2e-4e5b822a |
| `STORE-03/patch-patch` | E | storage | behavior | pass | e2e-4e5b822a |
| `STORE-03/delete-delete` | E | storage | behavior | pass | e2e-4e5b822a |
| `STORE-03/patch-delete` | E | storage | behavior | pass | e2e-4e5b822a |
| `STORE-04/same-id-create` | E | storage | behavior | pass | e2e-4e5b822a |
| `STORE-04/different-item-patch` | E | storage | behavior | pass | e2e-4e5b822a |
| `STORE-04/resend-create` | E | storage | behavior | pass | e2e-4e5b822a |
| `STORE-04/resend-delete` | E | storage | behavior | pass | e2e-4e5b822a |
| `STORE-05/lifecycle-tombstone` | E | storage | behavior | pass | e2e-4e5b822a |
| `STORE-05/delete-with-image` | E | storage | behavior | pass | e2e-4e5b822a |
| `API-14/rate-boundary-seeded` | E | storage | behavior | pass | e2e-4e5b822a |
| `STORE-03/both-read-old-i` | I | storage | behavior | not-run | liveでは未実行（implementation-pending）。offline: `tests/integration/formal-e2e/concurrency.test.ts` |
| `STORE-04/create-race-i` | I | storage | behavior | not-run | liveでは未実行（implementation-pending）。offline: `tests/integration/formal-e2e/concurrency.test.ts` |
| `STORE-06/items-1000-boundary-i` | I | storage | behavior | not-run | liveでは未実行（implementation-pending）。offline: `tests/integration/formal-e2e/quota.test.ts` |
| `STORE-06/items-1000-concurrent-i` | I | storage | behavior | not-run | liveでは未実行（implementation-pending）。offline: `tests/integration/formal-e2e/quota.test.ts` |
| `STORE-06/items-1000-delete-recovery-i` | I | storage | behavior | not-run | liveでは未実行（implementation-pending）。offline: `tests/integration/formal-e2e/quota.test.ts` |
| `STORE-06/image-128mib-boundary-i` | I | storage | behavior | not-run | liveでは未実行（implementation-pending）。offline: `tests/integration/formal-e2e/quota.test.ts` |
| `STORE-06/image-128mib-concurrent-i` | I | storage | behavior | not-run | liveでは未実行（implementation-pending）。offline: `tests/integration/formal-e2e/quota.test.ts` |
| `STORE-06/image-128mib-delete-recovery-i` | I | storage | behavior | not-run | liveでは未実行（implementation-pending）。offline: `tests/integration/formal-e2e/quota.test.ts` |
| `IMG-01/png-base64` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-01/png-dataurl` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-01/jpeg-base64` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-01/jpeg-dataurl` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-01/gif-base64` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-01/gif-dataurl` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-01/webp-base64` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-01/webp-dataurl` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-01/null` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-01/empty` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-01/omitted` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-02/bad-alphabet` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-02/bad-pad-bits` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-02/bad-padding` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-02/bad-length` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-02/mime-mismatch` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-02/unsupported-mime` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-02/not-an-image` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-02/missing-base64-marker` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-03/bytes-1048575` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-03/bytes-1048576` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-03/bytes-1048577` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-04/issue-and-fetch` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-05/other-owner` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-05/no-image` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-05/deleted-item` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-06/replace` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-06/omit-keeps` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-06/clear-null` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-06/clear-empty` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-06/delete` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-07/duplicate-id-with-image` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-07/duplicate-after-delete` | E | images | behavior | pass | e2e-4e5b822a |
| `IMG-08/pending-and-unknown-results-i` | I | images | behavior | not-run | liveでは未実行（implementation-pending）。offline: `tests/runtime/images.test.ts` |
| `IMG-09/signature-enforcement` | L | images | compatibility | unsupported | signature-enforcement-unsupported（Flociは署名/期限を強制しない） |
| `CLEAN-01/unpublished` | E | cleanup | behavior | pass | e2e-4e5b822a |
| `CLEAN-01/published-counts` | E | cleanup | behavior | pass | e2e-4e5b822a |
| `CLEAN-01/event-injection` | E | cleanup | behavior | pass | e2e-4e5b822a |
| `CLEAN-02/pending-24h-both-sides` | E | cleanup | behavior | pass | e2e-4e5b822a |
| `CLEAN-02/retired-origin-replace` | E | cleanup | behavior | pass | e2e-4e5b822a |
| `CLEAN-02/delete-tombstone` | E | cleanup | behavior | pass | e2e-4e5b822a |
| `CLEAN-03/active-lease` | E | cleanup | behavior | pass | e2e-4e5b822a |
| `CLEAN-03/expired-lease` | E | cleanup | behavior | pass | e2e-4e5b822a |
| `CLEAN-03/unrecorded-version` | E | cleanup | behavior | pass | e2e-4e5b822a |
| `CLEAN-04/committed-protected` | E | cleanup | behavior | pass | e2e-4e5b822a |
| `CLEAN-05/version-mismatch` | E | cleanup | behavior | pass | e2e-4e5b822a |
| `CLEAN-05/checksum-mismatch` | E | cleanup | behavior | pass | e2e-4e5b822a |
| `CLEAN-05/existing-marker-and-absent` | E | cleanup | behavior | pass | e2e-4e5b822a |
| `CLEAN-06/same-shard-51-two-invokes` | E | cleanup | behavior | pass | e2e-4e5b822a |
| `CLEAN-09/second-invoke-converges` | E | cleanup | behavior | pass | e2e-4e5b822a |
| `CLEAN-02/exact-boundary-i` | I | cleanup | behavior | not-run | liveでは未実行（implementation-pending）。offline: `tests/integration/formal-e2e/cleanup-resume.test.ts` |
| `CLEAN-03/exact-lease-boundary-i` | I | cleanup | behavior | not-run | liveでは未実行（implementation-pending）。offline: `tests/integration/formal-e2e/cleanup-resume.test.ts` |
| `CLEAN-04/stale-gsi-and-claim-race-i` | I | cleanup | behavior | not-run | liveでは未実行（implementation-pending）。offline: `tests/integration/formal-e2e/cleanup-resume.test.ts`、`tests/runtime/cleanup.test.ts` |
| `CLEAN-07/page-abort-resume-i` | I | cleanup | behavior | not-run | liveでは未実行（implementation-pending）。offline: `tests/integration/formal-e2e/cleanup-resume.test.ts`、`tests/runtime/cleanup.test.ts` |
| `CLEAN-08/limits-and-resume-i` | I | cleanup | behavior | not-run | liveでは未実行（implementation-pending）。offline: `tests/integration/formal-e2e/cleanup-resume.test.ts` |
| `CLEAN-09/fault-matrix-i` | I | cleanup | behavior | not-run | liveでは未実行（implementation-pending）。offline: `tests/integration/formal-e2e/cleanup-resume.test.ts`、`tests/runtime/cleanup.test.ts` |
| `OPS-01/two-owners-import-verify-publish` | L | operations | behavior | pass | e2e-4e5b822a |
| `OPS-02/interrupted-import-resumes-without-duplicates` | L | operations | behavior | pass | e2e-4e5b822a |
| `OPS-02/changed-inputs-rejected-state-unchanged` | L | operations | behavior | pass | e2e-4e5b822a |
| `OPS-02/corrupt-image-and-checksum-mismatch-never-publish` | L | operations | behavior | pass | e2e-4e5b822a |
| `OPS-03/restored-prepare-verify-preserve-rerun` | L | operations | behavior | pass | e2e-4e5b822a |
| `OPS-03/restored-tables-switch-and-return` | L | operations | behavior | pass | e2e-4e5b822a |
| `OPS-04/no-automatic-mapping-explicit-remap` | L | operations | behavior | pass | e2e-4e5b822a |
| `OPS-04/collision-and-bad-counter-never-ready` | L | operations | behavior | pass | e2e-4e5b822a |
| `STORE-07/transaction-uncertain-outcomes-i` | I | operations | behavior | not-run | liveでは未実行（implementation-pending）。offline: `tests/integration/formal-e2e/faults.test.ts` |
| `IMG-08/real-adapter-fault-positions-i` | I | operations | behavior | not-run | liveでは未実行（implementation-pending）。offline: `tests/integration/formal-e2e/faults.test.ts` |
| `API-01/ready-dependency-failure-keeps-health200-i` | I | operations | behavior | not-run | liveでは未実行（implementation-pending）。offline: `tests/integration/formal-e2e/faults.test.ts` |
| `OBS-02/crud-success-result-logs` | E | logging | behavior | pass | e2e-4e5b822a |
| `OBS-02/input-rejection-result-logs` | E | logging | behavior | pass | e2e-4e5b822a |
| `OBS-02/gateway-refusal-result-absence` | E | logging | behavior | pass | e2e-4e5b822a |
| `OBS-03/cleanup-start-end-pairing` | E | logging | behavior | pass | e2e-4e5b822a |
| `OPS-06/one-time-trigger` | L | scheduler | compatibility | pass | e2e-4e5b822a |
| `OPS-06/daily-schedule-preserved` | L | scheduler | behavior | pass | e2e-4e5b822a |
