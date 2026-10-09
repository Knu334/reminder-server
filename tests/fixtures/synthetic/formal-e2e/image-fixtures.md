# Synthetic image fixtures (formal E2E)

All image data is invented. The files are not decodable images: the product only checks the format signature and preserves the
bytes, so these fixtures make no decoder claim. Original data exists in memory only and is never written to evidence.

## Generation rule (`imageBytes(format, bytes = 64, seed = 0)`)

* Length is exactly `bytes` and at least the signature length.
* Signatures: PNG `89 50 4E 47 0D 0A 1A 0A`; JPEG `FF D8 FF`; GIF `GIF89a`; WebP `RIFF`, uint32 little-endian `bytes - 8`, `WEBP`.
* Every following byte `i` is `(31 * i + 7 * seed + formatIndex) mod 256`, with formatIndex png 0, jpeg 1, gif 2, webp 3.
* The same arguments always give the same bytes; a different `seed` gives different bytes of the same format and length.
* Expected MIME, length and SHA-256 are computed from these bytes by the harness, never taken from the product response.

## Inputs derived from them

* BASE64: canonical standard alphabet with padding. data URL: `data:<mime>;base64,<BASE64>` with the matching MIME.
* Boundary sizes: PNG fixtures of 1048575, 1048576 (accepted, bytes preserved) and 1048577 (413 THUMBNAIL_TOO_LARGE) decoded bytes.
  The JSON body stays below 2097152 bytes, so a body-size refusal is never confused with the image limit.
* Invalid inputs (each its own case): non-alphabet character, non-zero pad bits, missing padding, length not a multiple of four,
  data URL MIME that differs from the signature, unsupported MIME, a non-image signature, data URL without `;base64`.

## Isolation

Each case uses its own synthetic owner. S3 observations are limited to `images/<ownerId>/`; counters and jobs are read for that
owner only. Signed URLs are fetched with no headers through the guarded local transport and are never recorded.
