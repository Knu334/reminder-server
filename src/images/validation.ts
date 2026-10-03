import { createHash } from "node:crypto";
import { ApiError } from "../shared/errors";
import type { DecodedImage } from "./types";

const MAX_IMAGE_BYTES = 1_048_576;
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);

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
export function decodeThumbnail(value: string | null): DecodedImage | null {
  if (value === null || value === "") return null;
  // Bound the entire input before matching/allocating. Supported data-URL headers are short.
  if (value.length > MAX_BASE64_LENGTH + 32) return invalidImage();
  let payload = value;
  let declaredMime: string | undefined;
  if (value.startsWith("data:")) {
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(value);
    if (!match || match[1] === undefined || match[2] === undefined) return invalidImage();
    declaredMime = match[1];
    payload = match[2];
  }
  if (payload.length > MAX_BASE64_LENGTH || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) return invalidImage();
  const data = Buffer.from(payload, "base64");
  if (data.length === 0 || data.length > MAX_IMAGE_BYTES || data.toString("base64") !== payload) return invalidImage();
  const mime = identifyMime(data);
  if (declaredMime !== undefined && declaredMime !== mime) return invalidImage();
  return { data, mime, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
}
