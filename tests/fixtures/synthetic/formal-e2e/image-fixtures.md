# 合成画像fixture（正式E2E）

画像データはすべて架空である。ファイルはdecodeできる画像ではない。製品が検査するのは形式のsignatureだけで、byteはそのまま保存する。そのため、これらのfixtureはdecoderについて何も主張しない。元のデータはメモリ上にだけ存在し、evidenceには決して書き込まない。

## 生成規則（`imageBytes(format, bytes = 64, seed = 0)`）

* 長さは正確に `bytes` であり、signatureの長さ以上である。
* signature: PNGは `89 50 4E 47 0D 0A 1A 0A`、JPEGは `FF D8 FF`、GIFは `GIF89a`、WebPは `RIFF`、uint32 little-endianの `bytes - 8`、`WEBP` である。
* signatureに続く位置 `i` の各byteは、`(31 * i + 7 * seed + formatIndex) mod 256` である。formatIndexは、png 0、jpeg 1、gif 2、webp 3である。
* 同じ引数からは、常に同じbyteが得られる。`seed` が異なると、同じ形式と長さで、異なるbyteになる。
* 期待するMIME、長さ、SHA-256は、harnessがこのbyteから計算する。製品の応答からは決して取らない。

## これらから導く入力

* BASE64: paddingありの、正準の標準alphabetである。data URL: `data:<mime>;base64,<BASE64>` で、MIMEは一致するものを使う。
* 境界のサイズ: decode後のbyte数が1048575、1048576（受理され、byteが保存される）、1048577（413 THUMBNAIL_TOO_LARGE）のPNG fixtureである。JSONのbodyは2097152 byte未満に保つ。そのため、bodyサイズによる拒否が、画像の上限と混同されることはない。
* 不正な入力（それぞれ別のcase）: alphabet外の文字、0でないpad bit、paddingの欠落、4の倍数でない長さ、signatureと異なるdata URLのMIME、未対応のMIME、画像でないsignature、`;base64` のないdata URL。

## 隔離

各caseは、それぞれ専用の合成ownerを使う。S3の観測は `images/<ownerId>/` に限る。counterとjobは、そのownerの分だけを読む。署名付きURLは、guard付きのローカルtransportを通してheaderなしで取得し、決して記録しない。
