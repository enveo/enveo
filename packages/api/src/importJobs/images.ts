import { IMPORT_JOB_MAX_IMAGES } from "@enveo/shared";
import type { ImportJobImageInput } from "./repository";

export { IMPORT_JOB_MAX_IMAGES };
/** The client downscales to 1600 px JPEG (~150–300 KB); 2 MiB leaves room for a dense desktop capture. */
export const IMPORT_JOB_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const IMPORT_JOB_MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;
/** Twenty-four decoded MiB expands to exactly thirty-two MiB of base64; reserve a small,
 * deterministic allowance for the JSON envelope, data-URL headers, ids, and locale. */
export const IMPORT_JOB_REQUEST_BODY_LIMIT_BYTES = 32 * 1024 * 1024 + 4096;

type ImportJobImageErrorCode = "invalid_image" | "too_large";

export class ImportJobImageError extends Error {
  constructor(readonly code: ImportJobImageErrorCode) {
    super(code);
    this.name = "ImportJobImageError";
  }
}

const DATA_URL = /^data:(image\/(?:jpeg|png|webp)|text\/plain);base64,([A-Za-z0-9+/]*={0,2})$/;
/** A statement page's extracted text; a dense page is a few KB, so this is generous. */
export const IMPORT_JOB_MAX_TEXT_PAGE_BYTES = 256 * 1024;
function isStrictBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  for (let index = 0; index < value.length - padding; index += 1) {
    const code = value.charCodeAt(index);
    const base64Character =
      (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2f;
    if (!base64Character) return false;
  }
  return true;
}

function hasMagic(mimeType: string, bytes: Uint8Array): boolean {
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
  }
  return (
    mimeType === "image/webp" &&
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

function decodeOne(value: string): ImportJobImageInput {
  const match = DATA_URL.exec(value);
  if (!match) throw new ImportJobImageError("invalid_image");
  const [, mimeType, encoded] = match;
  if (!mimeType || !encoded || !isStrictBase64(encoded)) throw new ImportJobImageError("invalid_image");

  const content = new Uint8Array(Buffer.from(encoded, "base64"));
  if (Buffer.from(content).toString("base64") !== encoded) throw new ImportJobImageError("invalid_image");
  if (mimeType === "text/plain") {
    // A statement page (see shared/importStatement.ts): UTF-8 text, no magic to check.
    if (content.byteLength === 0 || content.byteLength > IMPORT_JOB_MAX_TEXT_PAGE_BYTES) throw new ImportJobImageError("too_large");
    return { mimeType, content };
  }
  if (content.byteLength > IMPORT_JOB_MAX_IMAGE_BYTES) throw new ImportJobImageError("too_large");
  if (!hasMagic(mimeType, content)) throw new ImportJobImageError("invalid_image");
  return { mimeType, content };
}

export function decodeImportJobImages(values: readonly string[]): ImportJobImageInput[] {
  if (values.length === 0) throw new ImportJobImageError("invalid_image");
  if (values.length > IMPORT_JOB_MAX_IMAGES) throw new ImportJobImageError("too_large");

  const images: ImportJobImageInput[] = [];
  let totalBytes = 0;
  for (const value of values) {
    const image = decodeOne(value);
    totalBytes += image.content.byteLength;
    if (totalBytes > IMPORT_JOB_MAX_TOTAL_IMAGE_BYTES) throw new ImportJobImageError("too_large");
    images.push(image);
  }
  return images;
}
