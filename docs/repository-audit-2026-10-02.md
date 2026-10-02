リポジトリ改善調査 — UX・実装慣行・保守状況

調査日：2026-10-02。対象コミット：6f1562450450404d216d7b61e967da4206caaa1e。

画面を持たないWebPageReminder用APIサーバーを対象に、先のUX調査へAPI契約、セキュリティ、保存、TLS、コンテナ、依存関係、CI、開発環境の確認を統合した。改善項目は32件（優先度 高11・中20・低1）。条件付きのリスクと開発環境の問題を含むため、32件の実証済み脆弱性という意味ではない。

最優先は保存内容の保護、更新競合の検出、初回・本番設定の成立、証明書更新の安定化、保守対象ランタイムと依存関係の更新である。

**調査範囲と確認方法**

src全ファイル、README、package.json/lock、TypeScript/ESLint/build設定、Docker/Compose、GitHub Actions、devcontainerと関連hook・指示ファイルを確認した。実データ、秘密鍵、環境ファイルの内容は読み取っていない。クライアント側リポジトリ・実配備・アクセス制御の外部設定は対象に含めていない。

既存node_modulesにはロックとの不一致があった（Morganは1.12.1、指定とlockは1.10.1）。そこで公開ソースとlockだけを一時ディレクトリへコピーし、npm ciで構成し直して本番同一Node.js 22.21.1・Express 5.1.0・Morgan 1.10.1で確認した。依存installのlifecycle scriptsは実行せず、型検査・lint・ビルドはそれぞれ成功した。

APIは実際のアプリを一時保存先・一時ポートで動かして19リクエストを検証した。TLS更新は実装のproduction分岐を隔離し、fs・server・watcherをモックして再現した。devcontainerの認証不足とhookは独立レビューで隔離・模擬入力を使って確認し、firewallは実ルールを変更せずモックで確認した。uvのPythonで件数・区分・成果物の整合性も検証した。

公式ライフサイクル、保守状況、推奨とnpmの現行監査結果を参照した。フレームワーク固有の構文回答ではなくコードレビューのため、現ターンの資料確認は公式サイトと公式リポジトリを使用した。

**全改善項目の一覧**

| ID | 優先度 | 改善項目 | 確認の種類 |
|---|---|---|---|
| F01 | 高 | 保存入力の検証がなく、欠落フィールドで既存データが消える | 実行再現 |
| F02 | 高 | 全一覧の置換で別端末の変更が失われる | 実行再現 |
| F03 | 中 | 通常オブジェクトの継承プロパティを保存キーとして扱う | 実行再現 |
| F04 | 高 | 初回利用と保存先初期化の契約が成立していない | 実行再現 |
| F05 | 高・条件付き | ネットワーク許可だけではデータの所有者を識別できない | コード確認・公開形態依存 |
| F06 | 高・条件付き | アクセス拒否より前に100MBまでのJSONを解析する | コード確認・負荷試験なし |
| F07 | 中 | IP・DNSによる接続判定が不安定で毎リクエストに依存する | 実行再現・コード確認 |
| F08 | 中 | CORSのlocalhost判定と応答設定が広く曖昧 | 実行再現 |
| F09 | 中 | JSON APIのメディア型・応答型が保証されていない | 実行再現 |
| F10 | 中 | エラーが不透明で本番の障害原因を追跡できない | コード確認・実行再現 |
| F11 | 高 | 保存ファイルを直接切り詰めて書くため耐久性が低い | コード確認・故障注入なし |
| F12 | 中 | 各リクエストが全利用者のファイルを同期処理する | コード確認・実負荷測定なし |
| F13 | 高 | 証明書更新が接続停止・更新取りこぼし・プロセス例外を起こし得る | 実装を使った隔離モック再現 |
| F14 | 中・条件付き | 標準的なCertbot構成では中間証明書が送られない | 公式仕様照合・本番証明書未確認 |
| F15 | 高 | 配布されたCompose設定のままでは本番起動・永続化が成立しない | 起動再現・コード確認 |
| F16 | 中 | 終了シグナル時のリクエスト完了待ちとリソース終了がない | コード確認・負荷下停止未検証 |
| F17 | 中 | 起動できていても使用不能な状態を判別できない | コード確認 |
| F18 | 中 | 本番コンテナがroot権限で動き、資源制約もない | Dockerfile確認・実コンテナ未検証 |
| F19 | 中 | ロック整合性とビルドコンテキストの最小化が不足 | 設定確認 |
| F20 | 高 | ロック済み依存に現在の既知脆弱性が残る | npm audit・Advisory照合 |
| F21 | 高 | 開発Node25はEOL、本番Node22の固定パッチも古い | 公式ライフサイクル照合・環境確認 |
| F22 | 中 | tsupは公式に積極的な保守を終了している | 公式リポジトリ照合 |
| F23 | 中 | CIが型・lint・振る舞い・起動を検証していない | 設定確認 |
| F24 | 中 | CIの権限・Action固定・継続更新方針が明示されていない | 設定確認・公式推奨照合 |
| F25 | 中 | 全体lintが生成物を解析し、大量の誤った指摘で失敗する | 実行確認 |
| F26 | 中 | strictだけでは外部入力と辞書参照の境界を検出できない | 追加型検査・公式推奨照合 |
| F27 | 中 | 認証必須の初期化とARM64既定値が参加者の起動を妨げる | 認証なし初期化再現・設定確認 |
| F28 | 中 | firewall再初期化と外部依存が開発環境を不安定にする | 隔離モック再現・コード確認 |
| F29 | 高・開発環境 | AI通信の既定送信先が明示選択なしの第三者proxy | 設定確認・実送信なし |
| F30 | 中 | 秘密ファイル保護の規則と実際の範囲が一致していない | 模擬入力によるhook検査・追跡状態確認 |
| F31 | 中 | 新規利用者向けの仕様とリポジトリ指示が実装に一致しない | ファイル・Git追跡確認 |
| F32 | 低 | 起動副作用・不要な依存・診断設定を小さく整理できる | コード確認 |

**各項目の根拠・改善案・移行への影響**

**F01：保存入力の検証がなく、欠落フィールドで既存データが消える（高／API・UX）**

根拠：[src/router/index.ts](/workspace/src/router/index.ts:7)、[src/util/reminderUtils.ts](/workspace/src/util/reminderUtils.ts:15)。確認：実行再現。

PUTでremindersを省略するとundefinedが代入され、JSON化で既存のキーが消える。keyの省略はundefinedという保存キーになり、不正な日時、配列以外のreminders、必須項目の欠落も200で受理される。型宣言は外部入力を検証しない。

改善案：リクエスト全体と各項目を実行時に検証し、日時・URLスキーム・IDの一意性・文字列長・件数を制限する。不正入力は400または422で拒否し、既存データを変更しない。旧データも移行前に検査する。

互換性・条件：厳格化すると、現在受理される不完全な旧クライアントの入力が拒否される。クライアント修正またはv2移行が必要。

照合資料：[Expressの入力検証に関する公式推奨](https://expressjs.com/en/advanced/best-practice-security/)。

**F02：全一覧の置換で別端末の変更が失われる（高／API・UX）**

根拠：[src/router/index.ts](/workspace/src/router/index.ts:6)、[src/util/reminderUtils.ts](/workspace/src/util/reminderUtils.ts:15)。確認：実行再現。

同じ一覧を取得した端末Aが項目を追加し、その後Bが取得済みの古い一覧を編集して保存すると、Aの追加が消える。順番に処理したリクエストでも発生し、同一プロセスの同期ファイルI/Oの競合とは別の問題。

改善案：保存時にrevisionを照合する条件付き更新を導入し、競合は412または定義した409で知らせる。さらにID単位の作成・更新・削除へ移行する。個別更新でも同じ項目の競合検出は必要。

互換性・条件：新しい更新契約はクライアント変更を伴う。DB移行だけではこの問題は解決しない。

**F03：通常オブジェクトの継承プロパティを保存キーとして扱う（中／API・UX）**

根拠：[src/util/reminderUtils.ts](/workspace/src/util/reminderUtils.ts:9)、[src/util/reminderUtils.ts](/workspace/src/util/reminderUtils.ts:15)。確認：実行再現。

__proto__への保存は成功するがファイルに残らず、取得は配列ではない継承オブジェクトを返す。constructorの取得は500。配列やオブジェクトのkeyも文字列へ暗黙変換される。グローバルなObject.prototype汚染を実証したものではない。

改善案：keyを適切な文字列に限定し、Object.hasOwnによる取得、nullプロトタイプの辞書、MapまたはDBを使用する。既存の特殊キーは移行時に検査する。

互換性・条件：特殊キーや非文字列キーの扱いが変わる。

**F04：初回利用と保存先初期化の契約が成立していない（高／API・UX）**

根拠：[src/util/reminderUtils.ts](/workspace/src/util/reminderUtils.ts:4)、[src/util/reminderUtils.ts](/workspace/src/util/reminderUtils.ts:7)、[src/router/index.ts](/workspace/src/router/index.ts:14)。確認：実行再現。

保存ファイルがなければ保存も取得も失敗する。未登録キーの取得は200・空本文で、Reminder[]という戻り値型とも一致しない。リポジトリの保存用JSONが存在しても、既定値は別名のreminders.txt。

改善案：保存先を起動時に検証し、新規ストアを安全に初期化する。未登録利用者には空配列など一貫した初回状態を返す。破損ストアは無条件で空にせず、復旧可能なエラーにする。

互換性・条件：空本文に依存するクライアントがあれば調整する。

**F05：ネットワーク許可だけではデータの所有者を識別できない（高・条件付き／セキュリティ）**

根拠：[src/middleware/reminderMiddleware.ts](/workspace/src/middleware/reminderMiddleware.ts:36)、[src/router/index.ts](/workspace/src/router/index.ts:7)、[src/router/index.ts](/workspace/src/router/index.ts:13)。確認：コード確認・公開形態依存。

許可された送信元からのリクエストは任意のkeyで取得・更新できる。共有NATやプロキシのIPは利用者本人の識別にならない。keyが十分ランダムな秘密資格情報であるという契約も記載されていない。公開・共有利用なら重要で、信頼済みの単一利用者専用なら境界を明記する。

改善案：認証主体から所有者を決定し、クライアントが任意に所有者を指定する形を廃止する。端末ペアリング、資格情報の失効・再発行を検討する。CORSやHelmetを認証として扱わない。

互換性・条件：認証導線と旧keyの紐付けが必要。利用者が外出先から接続するUXも改善できる。

**F06：アクセス拒否より前に100MBまでのJSONを解析する（高・条件付き／セキュリティ）**

根拠：[src/app.ts](/workspace/src/app.ts:17)、[src/app.ts](/workspace/src/app.ts:22)。確認：コード確認・負荷試験なし。

JSONとフォームの解析がIP判定より先にある。拒否対象の送信元でも解析のCPU・メモリを消費できる。保存件数や利用者別容量に上限がなく、巨大データが全量I/Oの負荷を増やす。

改善案：可能な送信元判定は本文解析前に行い、製品に必要な本文サイズ、件数、文字列長、利用者別容量を定める。公開形態に応じてリクエスト頻度・接続数・コンテナ資源を制限する。

互換性・条件：現状の大きなペイロードや無制限利用は制約を受ける。実データ分布から上限を決める。

**F07：IP・DNSによる接続判定が不安定で毎リクエストに依存する（中／API・UX）**

根拠：[src/middleware/reminderMiddleware.ts](/workspace/src/middleware/reminderMiddleware.ts:36)。確認：実行再現・コード確認。

IPv4とIPv4-mapped IPv6の文字列表記差でローカル接続が403となる。1件のDNS結果だけを比較し、複数A/AAAA・DNS失敗・プロキシ経由も十分に定義されていない。ALLOW_DOMAIN未設定は本番同一Node22.21.1では403とDNS非推奨警告、前回Node25では500となった。

改善案：必要設定を起動時に検証する。残すならアドレスを正規化し、意図した複数アドレスと更新方針を定義する。プロキシを使う場合は信頼する経路を限定し、無条件のtrust proxyは避ける。

互換性・条件：推奨はF05の認証へ移行し、IP制限は必要な追加境界として残す。

**F08：CORSのlocalhost判定と応答設定が広く曖昧（中／セキュリティ）**

根拠：[src/middleware/reminderMiddleware.ts](/workspace/src/middleware/reminderMiddleware.ts:9)、[src/middleware/reminderMiddleware.ts](/workspace/src/middleware/reminderMiddleware.ts:25)。確認：実行再現。

http://notlocalhost:9000も許可される正規表現を本番でも使用する。反映するOriginに対してVary: Originがなく、credentialsを常に許可する。res.send(204)は200・本文204となる。ただし200は成功するプリフライトのステータスなので、これだけでブラウザ接続不能とは断定しない。

改善案：許可OriginをURLとして厳密に扱い、開発と本番の許可設定を分ける。必要なメソッド・ヘッダー・資格情報だけ許可し、Originに応じて応答を変える場合はVaryを付ける。OPTIONSは実際の空204を返す。

互換性・条件：広い許可ルールに依存した接続元は設定の見直しが必要。POSTが許可メソッド一覧にないだけで取得失敗とは断定しない。

**F09：JSON APIのメディア型・応答型が保証されていない（中／API・UX）**

根拠：[src/router/index.ts](/workspace/src/router/index.ts:14)、[src/app.ts](/workspace/src/app.ts:18)。確認：実行再現。

文字列をremindersとして保存すると取得は200 text/htmlになる。text/plainのPUTは未解析のbodyを分解して500となる。任意に解釈されるフォームもJSON専用の契約と合わない。

改善案：対応するContent-Typeを定め、非対応は415、JSONは常に定義したJSON応答にする。保存済みデータも検査する。不要なフォーム解析を外す。個人データの応答と将来のGET化ではキャッシュ方針も明示する。

互換性・条件：フォームや文字列の保存に依存するクライアントは変更する。現時点で保存型XSSやキャッシュ漏洩を実証したものではない。

**F10：エラーが不透明で本番の障害原因を追跡できない（中／API・運用）**

根拠：[src/app.ts](/workspace/src/app.ts:33)、[src/middleware/reminderMiddleware.ts](/workspace/src/middleware/reminderMiddleware.ts:43)。確認：コード確認・実行再現。

例外の詳細ログはdevelopment時のみで、本番の応答は一律メッセージ、403は空。アクセスログのステータスだけでは、設定不足・入力不正・DNS・保存障害を区別できない。全環境で開発向けMorgan形式を使う。

改善案：エラーコード、検証項目、リクエストID、再試行可能性をAPI契約に含める。本番でも原因を構造化ログへ記録し、資格情報やリマインダー本文は必要なく記録しない。利用規模に応じて指標を追加する。

互換性・条件：クライアント側のエラー表示を合わせる。特定のログライブラリやOpenTelemetry導入を必須とはしない。

**F11：保存ファイルを直接切り詰めて書くため耐久性が低い（高／保存・運用）**

根拠：[src/util/reminderUtils.ts](/workspace/src/util/reminderUtils.ts:16)、[docker-compose.yml](/workspace/docker-compose.yml:9)。確認：コード確認・故障注入なし。

現用のJSONファイルへ直接書くため、途中停止・容量不足などで元の有効なデータを失う余地がある。バックアップ、破損検知、復旧手順がない。通常の単一プロセス同期I/Oで読み書きが割り込むという指摘ではない。

改善案：トランザクションを持つ保存先へ移行するか、同一ディレクトリの一時ファイルへの書き込みと原子的な置換、必要な同期・バックアップ・復旧検証を実装する。複数プロセスなら書き込みの調整も必要。

互換性・条件：原子的renameを採用する前に、単一ファイルのbind mountをディレクトリまたはvolumeへ変更する。保存先変更にはデータ移行・バックアップ・巻き戻し手順を用意する。

**F12：各リクエストが全利用者のファイルを同期処理する（中／保存・性能）**

根拠：[src/util/reminderUtils.ts](/workspace/src/util/reminderUtils.ts:7)、[src/util/reminderUtils.ts](/workspace/src/util/reminderUtils.ts:13)。確認：コード確認・実負荷測定なし。

取得でもファイル全体を読み込んでJSON解析し、保存は全体を再シリアライズする。イベントループが止まり、他の利用者のリクエストや証明書更新にも影響する。

改善案：容量と応答時間を計測し、項目単位で扱える保存先を検討する。非同期fsへの置き換えだけでは全量処理と更新競合は残り、無調整の非同期化は書き込み競合を増やし得る。

互換性・条件：小規模・単一利用者なら制限と耐久性対策で維持可能。SQLiteも同期APIを選べば自動的に非ブロッキングになるわけではない。

**F13：証明書更新が接続停止・更新取りこぼし・プロセス例外を起こし得る（高／TLS・運用）**

根拠：[src/app.ts](/workspace/src/app.ts:56)、[src/app.ts](/workspace/src/app.ts:61)、[src/app.ts](/workspace/src/app.ts:64)、[src/app.ts](/workspace/src/app.ts:91)。確認：実装を使った隔離モック再現。

読み込みに例外処理がなく、更新時に旧listenerを閉じてから新しく作る。再起動中のイベントは捨てる。A稼働中にBの更新を開始し、待機中にCへ更新したモックではBが適用されCが失われた。一時的な読み込み失敗もタイマー外へ例外が出た。

改善案：新しい鍵と証明書を検証し、失敗時は稼働中の設定を保持する。直接TLSを継続するならsetSecureContextで既存接続を維持し、変更をまとめて最新状態へ追従する。TLSをプロキシへ委譲する案も有効。

互換性・条件：直接修正はAPI互換を維持できる。TLS委譲は運用構成を変更する。実Certbot更新と実TLS接続の検証は別途必要。

照合資料：[Node.js 22のTLS更新API](https://nodejs.org/docs/latest-v22.x/api/tls.html#serversetsecurecontextoptions)。

**F14：標準的なCertbot構成では中間証明書が送られない（中・条件付き／TLS・運用）**

根拠：[src/app.ts](/workspace/src/app.ts:52)、[README.md](/workspace/README.md:58)。確認：公式仕様照合・本番証明書未確認。

cert.pemを読み込む。Certbot標準構成のcert.pemはleafで、fullchain.pemが中間証明書を含む。その構成ならクライアントがチェーンを構築できず接続に失敗する可能性がある。実際の証明書内容は読んでいない。

改善案：標準的な構成ではfullchain.pemを読み込み・監視する。鍵の権限、チェーン、更新手順を実際の配備環境で確認する。

互換性・条件：証明書ファイル名と監視対象、READMEの変更が必要。

照合資料：[Certbotの証明書ファイル仕様](https://eff-certbot.readthedocs.io/en/stable/using.html#where-are-my-certificates)。

**F15：配布されたCompose設定のままでは本番起動・永続化が成立しない（高／設定・運用）**

根拠：[docker-compose.yml](/workspace/docker-compose.yml:13)、[docker-compose.yml](/workspace/docker-compose.yml:15)、[src/app.ts](/workspace/src/app.ts:48)、[src/util/reminderUtils.ts](/workspace/src/util/reminderUtils.ts:4)。確認：起動再現・コード確認。

NODE_ENVはproductionだがCERT_PATHなどが空で、空のディレクトリからの本番起動はprivkey.pemのENOENTで終了した。保存用JSONのmountと既定保存先が一致せず、FRONTEND_ORIGINも設定例にない。

改善案：必須設定の未指定を明示的に拒否し、PORTの範囲、URL、パス、保存先の読み書き可能性を起動時に確認する。実行可能なサンプルと空の設定テンプレートを用意する。

互換性・条件：既存の曖昧な既定値に依存する運用は明示設定へ変更する。

**F16：終了シグナル時のリクエスト完了待ちとリソース終了がない（中／運用）**

根拠：[src/app.ts](/workspace/src/app.ts:45)、[src/app.ts](/workspace/src/app.ts:103)、[docker-compose.yml](/workspace/docker-compose.yml:20)。確認：コード確認・負荷下停止未検証。

サーバーとwatcherを追跡してSIGTERM/SIGINTで閉じる処理がない。Composeのinitはシグナル転送を補助するが、アプリの処理完了待ちを実装しない。

改善案：HTTP/HTTPSのserverを保持し、受付停止、watcher終了、進行中リクエストの完了待ち、期限付き強制終了を実装する。コンテナの停止猶予と一致させる。

互換性・条件：API互換を維持できる。

**F17：起動できていても使用不能な状態を判別できない（中／運用）**

根拠：[src/router/index.ts](/workspace/src/router/index.ts:4)、[docker-compose.yml](/workspace/docker-compose.yml:21)。確認：コード確認。

liveness/readiness endpointとhealthcheckがない。保存先が壊れてもプロセスは生存し、restart: alwaysでは検知・復旧できない。

改善案：軽量な生存確認と、初期化・保存先の利用可能性を示す準備完了確認を設ける。監視用リクエストがIP制限で拒否されないよう配置する。運用基盤に応じた検知と復旧を定義する。

互換性・条件：healthcheck追加だけでDockerが自動再起動するわけではない。

**F18：本番コンテナがroot権限で動き、資源制約もない（中／コンテナ）**

根拠：[Dockerfile](/workspace/Dockerfile:10)、[docker-compose.yml](/workspace/docker-compose.yml:8)。確認：Dockerfile確認・実コンテナ未検証。

実行段にUSERがなく、アプリが不要なroot権限を持つ。Composeのmemory/CPU等の制約もなく、大きな本文やファイルがホスト側へ影響する余地がある。

改善案：非特権ユーザーで実行し、保存volumeと証明書のアクセス権を合わせる。必要な書き込み領域を限定し、資源制限を実負荷から決める。read-onlyやcapability制限は実行条件に合わせる。

互換性・条件：保存先の所有者と秘密鍵の読取権限を調整する必要がある。

**F19：ロック整合性とビルドコンテキストの最小化が不足（中／コンテナ・ビルド）**

根拠：[Dockerfile](/workspace/Dockerfile:5)、[Dockerfile](/workspace/Dockerfile:6)、[.github/workflows/docker-compose-build.yml](/workspace/.github/workflows/docker-compose-build.yml:32)。確認：設定確認。

npm installを使い、ロック不一致を拒否するnpm ciではない。.dockerignoreがなく、ローカルの環境ファイル・データ・Git履歴・node_modulesをビルド対象から除外していない。ただし限定COPYなので、これらが最終イメージへ入るとは断定しない。

改善案：npm ciで再現性を担保し、.dockerignoreで不要・機密ファイルを除外する。ベースイメージはdigest固定と定期更新を組み合わせる。開発用グローバルツール・リモートinstallerも更新方針を明示する。

互換性・条件：ロック更新が必要な場合は開発時に行ってレビューする。digest固定だけでは古いパッチを防げない。

照合資料：[npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/)、[Dockerのビルド推奨](https://docs.docker.com/build/building/best-practices/)。

**F20：ロック済み依存に現在の既知脆弱性が残る（高／依存関係）**

根拠：[package-lock.json](/workspace/package-lock.json:1)、[package.json](/workspace/package.json:15)。確認：npm audit・Advisory照合。

全依存では脆弱性が報告された13パッケージ（High 7、Moderate 4、Low 2）。本番依存は4パッケージ（High 1、Moderate 2、Low 1）。本番はpath-to-regexp、morgan、qs、body-parser。これは到達可能な攻撃の件数ではない。

改善案：直接依存とロックを更新し、推移依存も修正版へ更新する。morganは指定範囲~1.10.1の変更が必要。修正後にAPI・ビルド・監査を再検証し、強制的な一括メジャー更新は避ける。

互換性・条件：既知のpath-to-regexp Highは複数optional group等のルートで成立し、現状の固定/remindersにはそのパターンがない。body-parserの指摘も現在の有効な100mb値にそのまま当てはまらない。更新は推奨するが即時悪用可能と断定しない。

照合資料：[path-to-regexpのAdvisory](https://github.com/advisories/GHSA-j3q9-mxjg-w52f)、[MorganのAdvisory](https://github.com/advisories/GHSA-9f6g-j8ch-79g4)、[body-parserのAdvisory](https://github.com/advisories/GHSA-v422-hmwv-36x6)、[qsのAdvisory](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g)。

**F21：開発Node25はEOL、本番Node22の固定パッチも古い（高／ランタイム・トレンド）**

根拠：[.devcontainer/Dockerfile](/workspace/.devcontainer/Dockerfile:2)、[Dockerfile](/workspace/Dockerfile:3)、[package.json](/workspace/package.json:1)。確認：公式ライフサイクル照合・環境確認。

開発は25.8.2、本番は22.21.1。2026-10-02時点でNode25は2026-06-01にEOL。Node22系は2027-04-30まで保守対象なので、22であること自体は問題ではないが、22.21.1以後のセキュリティ修正を取り込めていない。環境差は空DNS名の挙動にも現れた。

改善案：サポート中LTSの更新済みパッチへ揃え、開発・CI・本番のバージョン方針をpackage.json等に明示する。Node24 LTSへ統一する案も候補。

互換性・条件：メジャー更新は動作確認が必要。2026-10-02時点でNode26はCurrentなので、最新番号を優先して本番へ移す理由にはしない。

照合資料：[Node.js公式Release Schedule](https://github.com/nodejs/Release)、[2026年7月のセキュリティ更新](https://nodejs.org/en/blog/vulnerability/july-2026-security-releases)。

**F22：tsupは公式に積極的な保守を終了している（中／ビルド・トレンド）**

根拠：[package.json](/workspace/package.json:28)、[tsup.config.ts](/workspace/tsup.config.ts:3)。確認：公式リポジトリ照合。

公式READMEが積極的に保守していないこととtsdown検討を案内する。現状のビルドは動作しており、今すぐ停止するという指摘ではない。長期保守と更新追従の観点で見直す価値がある。

改善案：既存の単一ファイル配布を続けるならtsdown等の保守されるビルド手段を比較する。小さなNodeサーバーなのでtscと通常の本番依存配置へ簡素化する案も比較する。

互換性・条件：CJS/ESM、パスalias、外部依存、Dockerの配布ファイル構成を確認する。bundler交換自体を目的にしない。

照合資料：[tsup公式README](https://github.com/egoist/tsup)。

**F23：CIが型・lint・振る舞い・起動を検証していない（中／CI・品質）**

根拠：[.github/workflows/docker-compose-build.yml](/workspace/.github/workflows/docker-compose-build.yml:2)、[.github/workflows/docker-compose-build.yml](/workspace/.github/workflows/docker-compose-build.yml:25)、[package.json](/workspace/package.json:5)。確認：設定確認。

push/manualのビルドのみでPR triggerがない。型・lint・API・初回保存・競合・TLS更新・本番起動の検証がない。BuildxとComposeで再度ビルドするが、設定や起動不備は捕まらない。

改善案：PRでtypecheck、lint、意味のある境界・統合テストと本番起動smoke testを実行する。テスト用証明書と一時保存先を使う。ビルドを一度にまとめ、Composeは構成と動作を検証する。

互換性・条件：利用者のコードと実データをテストへ持ち込まず、サポートするNodeで確認する。

**F24：CIの権限・Action固定・継続更新方針が明示されていない（中／CI・サプライチェーン）**

根拠：[.github/workflows/docker-compose-build.yml](/workspace/.github/workflows/docker-compose-build.yml:10)。確認：設定確認・公式推奨照合。

GITHUB_TOKENのpermissionsがなく、Actionは可変のmajor tagを参照する。依存更新の自動化や脆弱性チェックもない。実際のデフォルト権限はリポジトリ設定に依存するので、書き込み権限があるとは断定しない。

改善案：必要最小限のpermissionsを明記し、Actionを検証済みcommit SHAへ固定する。Dependabot等でAction・依存・イメージの更新を継続する。小規模なprivateサーバーで過度な署名・配布基盤を必須とはしない。

互換性・条件：更新通知とレビューを含めて運用する。

照合資料：[GitHub Actionsのセキュリティ推奨](https://docs.github.com/en/actions/reference/security/secure-use)。

**F25：全体lintが生成物を解析し、大量の誤った指摘で失敗する（中／lint・開発）**

根拠：[eslint.config.mjs](/workspace/eslint.config.mjs:8)、[eslint.config.mjs](/workspace/eslint.config.mjs:9)。確認：実行確認。

eslint .は既存dist/app.jsを対象に586 errors・3 warningsで失敗した。distをCLIで除外すると通過する。Nodeサーバーなのにbrowser globalsを設定しており、環境の宣言も合っていない。

改善案：生成物を設定で除外し、対象ファイルとNode globalsを明示する。CIと開発で同じlintコマンドを実行する。型情報を利用するlintはF26として検討する。

互換性・条件：アプリのソースが586件壊れているという結果ではない。

**F26：strictだけでは外部入力と辞書参照の境界を検出できない（中／型・API契約）**

根拠：[tsconfig.json](/workspace/tsconfig.json:87)、[eslint.config.mjs](/workspace/eslint.config.mjs:11)、[src/util/reminderUtils.ts](/workspace/src/util/reminderUtils.ts:9)、[src/types/types.ts](/workspace/src/types/types.ts:6)。確認：追加型検査・公式推奨照合。

noUncheckedIndexedAccessを有効にした一時検査はgetRemindersのReminder[] | undefinedを検出した。現在は型情報なしのlintで、req.bodyは実際の内容を保証しない。日時・所有者・createdAt等の意味も型のstringだけでは定まらない。

改善案：実行時schemaを契約の中心にし、API・クライアントの型と仕様書を揃える。noUncheckedIndexedAccess、必要に応じたexactOptionalPropertyTypesとtyped lintを導入する。日時のoffset/timezoneと作成時刻の決定主体を定義する。

互換性・条件：既存データの検査とクライアント契約変更が必要。TypeScriptやESLintの最新majorへ一括更新すること自体は改善条件ではない。

照合資料：[typescript-eslintのtyped lint推奨](https://typescript-eslint.io/getting-started/typed-linting/)。

**F27：認証必須の初期化とARM64既定値が参加者の起動を妨げる（中／開発UX）**

根拠：[.devcontainer/init-git.sh](/workspace/.devcontainer/init-git.sh:7)、[.devcontainer/devcontainer.json](/workspace/.devcontainer/devcontainer.json:26)、[.devcontainer/docker-compose.yml](/workspace/.devcontainer/docker-compose.yml:10)、[package.json](/workspace/package.json:5)。確認：認証なし初期化再現・設定確認。

GitHub未認証の空homeではinit-gitが失敗する。初期化を&&で連結して完了待ちするため、通常の開発に不要な認証で起動を妨げる。イメージはARM64を既定とし、x86では明示overrideかemulationが必要。startも開発用nodemonしかない。

改善案：未認証なら認証設定をskipし、任意のAI連携を基本開発から切り離す。architecture-neutralなイメージを既定とする。dev/build/typecheck/lint/production startを分かる形で提供する。

互換性・条件：従来の開発用startはdevへ移す場合、利用手順と自動化を更新する。ARM64選択を意図した利用者のoverrideは残せる。

**F28：firewall再初期化と外部依存が開発環境を不安定にする（中／開発ネットワーク）**

根拠：[.devcontainer/init-firewall.sh](/workspace/.devcontainer/init-firewall.sh:9)、[.devcontainer/init-firewall.sh](/workspace/.devcontainer/init-firewall.sh:45)、[.devcontainer/init-firewall.sh](/workspace/.devcontainer/init-firewall.sh:108)、[.devcontainer/init-firewall.sh](/workspace/.devcontainer/init-firewall.sh:135)。確認：隔離モック再現・コード確認。

既存のDROP policyを残してルールを消し、許可ルールを作る前にGitHubへアクセスする。モックでは初期ACCEPTからは成功、既存DROPのnetwork namespaceでの再実行は最初のfetchで失敗した。fetchに総時間上限がなく、任意連携先のDNS失敗も全体を止める。

改善案：既存の正常ルールを保ったまま新設定を取得・検証し、chain/ipsetを原子的に置換する。時間上限、optional連携の分離、アドレス更新を設ける。

互換性・条件：すべてのDocker再起動で失敗するとまでは確認していない。広いGoogle IP、SSH、DNSとIPv6未定義を含み、厳密なdomain-only境界とは説明しない。

**F29：AI通信の既定送信先が明示選択なしの第三者proxy（高・開発環境／開発プライバシー）**

根拠：[.devcontainer/docker-compose.yml](/workspace/.devcontainer/docker-compose.yml:31)。確認：設定確認・実送信なし。

ANTHROPIC_BASE_URLの既定値は第三者proxy.bar504.netで、同設定にはAPI keyを渡す設定もある。この設定を利用する開発ツールは、利用者が明示的に選ぶ前にコード・prompt・資格情報を第三者へ送る構成になり得る。実際に送信されたとは確認していない。

改善案：vendor endpointを既定にするか送信先の明示設定を必須にし、proxy利用は選択制にする。送信先とデータの扱いを開発手順で説明する。

互換性・条件：そのproxyを意図した利用者は明示的に設定する。運営主体が悪意を持つという指摘ではない。

**F30：秘密ファイル保護の規則と実際の範囲が一致していない（中／開発・秘密情報）**

根拠：[.codex/hooks/check-bash-command.sh](/workspace/.codex/hooks/check-bash-command.sh:5)、[.claude/hooks/check-bash-command.sh](/workspace/.claude/hooks/check-bash-command.sh:5)、[.claude/settings.json](/workspace/.claude/settings.json:3)、[.gitignore](/workspace/.gitignore:75)。確認：模擬入力によるhook検査・追跡状態確認。

両hookの模擬コマンドcat .envとcat .env.actionsはdenyされず、printenvはdenyされた。Read patternは.env.actionsを含まず、そのファイルはGit追跡されている。内容を読んでいないため資格情報漏洩の証拠ではない。Codex側のhook登録互換性は未検証。

改善案：秘密ファイル名と例外となる公開sampleを明確化し、ignoreとアクセス規則を整合させる。正規表現のコマンド検査を強固なファイルアクセス制御と同一視しない。

互換性・条件：.env.actionsが公開sampleならその意図を名前と手順で明示する。秘密情報を含むかは管理者が確認する。

**F31：新規利用者向けの仕様とリポジトリ指示が実装に一致しない（中／ドキュメント・指示）**

根拠：[README.md](/workspace/README.md:23)、[README.md](/workspace/README.md:125)、[README.md](/workspace/README.md:134)。確認：ファイル・Git追跡確認。

環境変数一覧にALLOW_DOMAINとFRONTEND_ORIGINがない。保存例はtimeを使うが型はreminderTimeと他の必須項目を要求する。HTTP/HTTPSと環境変数の読み込み方法も整理が必要。AGENTS.mdは未追跡・欠落したCLAUDE.mdへのsymlinkで、新規checkoutでは読めない。

改善案：実行可能な設定と正しい完全な入出力例、初回・検証・競合・障害の契約を記載する。共通指示ファイルを復元するかAGENTS.mdを実体化する。同期処理の同時書き込み説明は単一/複数プロセスを分ける。

互換性・条件：クライアント契約の更新と同時に文書を検証する。

**F32：起動副作用・不要な依存・診断設定を小さく整理できる（低／保守性）**

根拠：[src/app.ts](/workspace/src/app.ts:14)、[src/app.ts](/workspace/src/app.ts:45)、[package.json](/workspace/package.json:21)、[tsup.config.ts](/workspace/tsup.config.ts:3)。確認：コード確認。

アプリ構成、TLS管理、watcher、listenが一つのファイルで動き、importすると起動する。未使用のgreenlock-express型などが残り、source mapを出す設定もない。

改善案：createAppと起動/lifecycle処理、保存インターフェースを分けて実サーバーを起動せず検査できる構造にする。不要な直接依存とmiddlewareを整理し、bundle配布ならsource mapとスタック追跡を整える。

互換性・条件：この規模で複雑なDI・多数の層・マイクロサービス化を増やす必要はない。

**破壊的変更を含む再設計候補**

| 候補 | 得られるUX・保守性 | 移行範囲・条件 | 相対的な規模 |
|---|---|---|---|
| B01：認証主体に紐付く個別更新API | 接続場所によらず利用でき、他利用者のkeyを直接操作できない。1件の変更を確実に反映できる | クライアント、認証/ペアリング、旧keyと所有者の移行、API変更。F01/F02/F05/F09をまとめて扱う | 大 |
| B02：revisionと競合応答を持つ同期契約 | 別端末の変更を無言で消さず、競合を表示・再取得・解決できる | 旧一覧PUTの互換期間とv2を用意する。同じ項目の同時変更、再送、削除後の復活もテストする | 中〜大 |
| B03：トランザクションを持つ永続化 | 更新の耐久性、検索、復元機能の基盤を得る | SQLite等は単一インスタンスと運用規模に合わせて比較。JSON importer、backup/rollback、volume配置の変更が必要。競合検出は別途実装する | 中 |
| B04：削除の復元・日時の明示的な契約 | 誤操作を戻せ、端末間でリマインダー時刻を同じ意味で扱える | 削除API、期限・保持量、日時形式/timezone、既存データとクライアントの変更が必要 | 中 |
| B05：TLSをリバースプロキシへ委譲 | 証明書更新をアプリの再起動処理から分離し、運用しやすくする | appの通信モードと配備構成、TLS終端、信頼するproxy、内部ネットワークの設計を変更する。直接TLSを保守する案も可能 | 中 |
| B06：保守されるbuild手段または通常のtsc配布へ移行 | tsupの保守終了へ対応し、更新・診断を維持できる | bundle形式、path alias、外部依存、Docker成果物を確認する。ESM化は別の判断とする | 小〜中 |

リマインダーの実行主体も明文化する。このサーバーはautoOpen/webPushなどの設定を保存するが、scheduler、push subscription管理、配送結果は実装していない。クライアントが担当する設計なら欠陥とはしない。ブラウザを閉じても通知することが要件なら、クライアント側も含めた別の設計・権限・再送・重複防止が必要になる。

移行はv2契約・旧データ検査・互換期間を用意して行う。厳しい入力検証も既存の不完全な入力を拒否する変更になるため、先にクライアントとの契約を確認する。

**最近の保守状況との比較**

明確に更新理由があるのは、EOLの開発Node25、更新されない本番の固定パッチ、積極的保守を終了したtsup、既知Advisoryを含むロック、実行時schemaと型情報を活用していない境界処理である。Node22のLTS利用、Express5、CommonJS、npm、nodemon/ts-nodeは、それぞれ現在の要件を満たすなら継続できる。

ESM、別framework、別package manager、最新TypeScript/ESLint major、Kubernetes、microservicesへの移行は、流行だけを根拠に優先しない。現在の2つのAPIに対し、認証・保存・同期・起動確認の改善効果を基準に選ぶ。

維持したい土台は、strict TypeScript、lockfile、Helmet、productionのmulti-stage image、証明書mountのread-only、Composeのinit、開発用の非特権ユーザーである。

**依存監査の内訳と注意点**

| 範囲 | 脆弱性が報告されたパッケージ数 | High | Moderate | Low | Critical |
|---|---:|---:|---:|---:|---:|
| 全依存 | 13 | 7 | 4 | 2 | 0 |
| 本番依存 | 4 | 1 | 2 | 1 | 0 |

本番対象はpath-to-regexp 8.3.0（High）、morgan 1.10.1（Moderate）、qs 6.14.2（Moderate）、body-parser 2.2.1（Low）。開発側にはRollup、minimatch、brace-expansion、picomatch、flatted、js-yamlなどの指摘がある。開発依存の脆弱性を、最終imageで外部公開される脆弱性と同じに扱わない。

件数はnpm auditのパッケージ単位の集計で、CVEの総数や現在の攻撃到達数ではない。Morganも現在はdev形式なので、すべてのログ形式のAdvisoryがそのまま適用されるとはしない。公開された条件と使用経路を照合して優先度を付け、更新後に再監査する。

**検証結果と前回報告の補足**

| 確認 | 結果 |
|---|---|
| Node22.21.1＋lock通りの依存で型検査 | 成功 |
| 同環境でsrcのlint | 成功 |
| 同環境でbundle生成 | 成功 |
| 既存作業環境で全体lint | dist/app.jsを解析して586 errors・3 warnings |
| dist除外の全体lint | 成功 |
| noUncheckedIndexedAccess等を追加する検査 | getRemindersのundefined境界をTS2322で検出 |
| 実アプリの一時API検証 | 19リクエスト、期待した問題の再現を確認 |
| production証明書更新の隔離モック | 最新Cの取りこぼしとread例外の脱出を確認 |
| uv/Pythonによる集計 | 全依存/本番の区分と件数・検証結果の整合性を確認 |

前回のALLOW_DOMAIN未設定の500はNode25での結果である。本番同一Node22では403となり、空DNS名に非推奨警告が出た。いずれも設定不足を適切に案内できない問題だが、ステータスは環境で異なる。

res.send(204)の誤用やAccess-Control-Allow-MethodsからのPOST欠落だけを、ブラウザが必ず利用不能になる証拠とは扱わない。同期I/Oの問題を、単一プロセス内で同時に書き込みが割り込む問題とも扱わない。特殊keyの問題をグローバルprototype pollution、文字列応答を実証済みXSS、保存されたURLをSSRFと呼ぶ根拠もない。

実Docker build/run、実配備のTLS chainとCertbot更新、実ブラウザ、shutdown under load、disk full/強制停止の故障注入、利用者規模でのbenchmarkは未実施。Docker CLIはこの調査環境になかった。web UIの使い勝手と通知成功率は別リポジトリおよび配備環境の確認が必要。

**着手順**

1. F01/F02/F03/F04/F15：正しい保存と初回・起動契約を整え、データ喪失を防ぐ回帰検証を置く。
2. F20/F21/F29：依存とruntimeの保守更新、開発の既定送信先を見直す。
3. F11/F13/F14/F16/F17/F18：永続化、証明書更新、終了、監視、コンテナ権限を整える。
4. F05/F06/F07/F08/F09/F10：公開形態に合う認証・容量制限・接続・応答・ログ契約を実装する。
5. F19/F22/F23/F24/F25/F26/F27/F28/F30/F31/F32：CI、build、型・lint、参加者向け開発環境と文書を揃える。

上記は調査と候補整理であり、アプリの実装・依存更新・配備は行っていない。リポジトリへ追加する成果物はこの調査書のみである。
