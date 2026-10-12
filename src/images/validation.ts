import { createHash } from "node:crypto";
import { ApiError } from "../shared/errors";
import type { DecodedImage } from "./types";

const MAX_IMAGE_BYTES = 1_048_576;

function invalidImage(): never {
  throw new ApiError(422, "INVALID_THUMBNAIL", "Invalid or unsupported thumbnail");
}

function identifyMime(data: Buffer): string {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  const gif = data.toString("latin1", 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  if (data.length >= 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return invalidImage();
}

/** Sniff supported signatures and preserve the original bytes; no image transcoding. */
export function decodeThumbnail(value: string | null, maxBytes = MAX_IMAGE_BYTES): DecodedImage | null {
  if (value === null || value === "") return null;
  let payload = value;
  let declaredMime: string | undefined;
  if (value.startsWith("data:")) {
    const comma = value.indexOf(",");
    const header = value.slice(0, comma);
    if (!["data:image/png;base64", "data:image/jpeg;base64", "data:image/gif;base64", "data:image/webp;base64"].includes(header)) return invalidImage();
    declaredMime = header.slice(5, -7);
    payload = value.slice(comma + 1);
  }
  // Validate alphabet and pad bits without nested regular-expression groups or decoding an unbounded input.
  if (payload.length === 0 || payload.length % 4 !== 0) return invalidImage();
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const end = payload.length - padding;
  function digit(code: number): number {
    if (code >= 65 && code <= 90) return code - 65;
    if (code >= 97 && code <= 122) return code - 71;
    if (code >= 48 && code <= 57) return code + 4;
    return code === 43 ? 62 : code === 47 ? 63 : -1;
  }
  for (let index = 0; index < end; index++) if (digit(payload.charCodeAt(index)) < 0) return invalidImage();
  const last = digit(payload.charCodeAt(end - 1));
  if ((padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0)) return invalidImage();
  const bytes = payload.length / 4 * 3 - padding;
  const mime = identifyMime(Buffer.from(payload.slice(0, 16), "base64"));
  if (declaredMime !== undefined && declaredMime !== mime) return invalidImage();
  if (bytes > maxBytes) throw new ApiError(413, "THUMBNAIL_TOO_LARGE", "Thumbnail too large");
  const data = Buffer.from(payload, "base64");
  return { data, mime, bytes, sha256: createHash("sha256").update(data).digest("hex") };
}
