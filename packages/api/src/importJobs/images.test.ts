import { describe, expect, it } from "bun:test";
import { decodeImportJobImages, IMPORT_JOB_MAX_IMAGES, IMPORT_JOB_REQUEST_BODY_LIMIT_BYTES, ImportJobImageError } from "./images";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xdb]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

function imageUrl(mimeType: string, bytes: Uint8Array): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function sizedPng(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  bytes.set(PNG);
  return imageUrl("image/png", bytes);
}

function errorCode(work: () => unknown): string | null {
  try {
    work();
    return null;
  } catch (error) {
    return error instanceof ImportJobImageError ? error.code : "unexpected";
  }
}

describe("durable import image decoding", () => {
  it("accepts JPEG, PNG, and WebP only when the declared MIME matches the bytes", () => {
    const decoded = decodeImportJobImages([imageUrl("image/jpeg", JPEG), imageUrl("image/png", PNG), imageUrl("image/webp", WEBP)]);

    expect(decoded.map((image) => [image.mimeType, image.content.byteLength])).toEqual([
      ["image/jpeg", JPEG.byteLength],
      ["image/png", PNG.byteLength],
      ["image/webp", WEBP.byteLength],
    ]);
  });

  it("rejects unsupported MIME types, mismatched magic bytes, and non-canonical base64", () => {
    expect(errorCode(() => decodeImportJobImages([imageUrl("image/gif", new Uint8Array([0x47, 0x49, 0x46, 0x38]))]))).toBe("invalid_image");
    expect(errorCode(() => decodeImportJobImages([imageUrl("image/png", JPEG)]))).toBe("invalid_image");
    expect(errorCode(() => decodeImportJobImages(["data:image/png;base64,iVBORw0KGgo"]))).toBe("invalid_image");
    expect(errorCode(() => decodeImportJobImages(["data:image/png;base64,iVBORw0KGgo=!!"]))).toBe("invalid_image");
    expect(errorCode(() => decodeImportJobImages(["data:image/png;base64,iVBORw0KGgp="]))).toBe("invalid_image");
  });

  it("allows thirty images and rejects a thirty-first", () => {
    expect(decodeImportJobImages(Array.from({ length: IMPORT_JOB_MAX_IMAGES }, () => imageUrl("image/png", PNG)))).toHaveLength(30);
    expect(errorCode(() => decodeImportJobImages(Array.from({ length: IMPORT_JOB_MAX_IMAGES + 1 }, () => imageUrl("image/png", PNG))))).toBe("too_large");
  });

  it("accepts exactly 2 MiB per image and exactly 24 MiB total inside the request body limit", () => {
    const encodedImages = Array.from({ length: 12 }, () => sizedPng(2 * 1024 * 1024));
    const images = decodeImportJobImages(encodedImages);

    expect(images.reduce((total, image) => total + image.content.byteLength, 0)).toBe(24 * 1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(createRequest(encodedImages)))).toBeLessThanOrEqual(IMPORT_JOB_REQUEST_BODY_LIMIT_BYTES);
  });

  it("rejects either a per-image or aggregate decoded-byte overflow", () => {
    expect(errorCode(() => decodeImportJobImages([sizedPng(2 * 1024 * 1024 + 1)]))).toBe("too_large");
    expect(errorCode(() => decodeImportJobImages([...Array.from({ length: 12 }, () => sizedPng(2 * 1024 * 1024)), imageUrl("image/png", PNG)]))).toBe(
      "too_large",
    );
  });
});

function createRequest(images: string[]) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    budgetId: "22222222-2222-4222-8222-222222222222",
    accountId: "33333333-3333-4333-8333-333333333333",
    locale: "pl-PL",
    images,
  };
}
