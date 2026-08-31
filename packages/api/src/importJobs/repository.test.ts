import { describe, expect, test } from "bun:test";
import { computeImportJobRequestHash } from "./repository";

const request = () => ({
  id: "018f7c89-4d76-7b8a-9a3e-4d6bf4a99811",
  userId: "11111111-1111-4111-8111-111111111111",
  budgetId: "22222222-2222-4222-8222-222222222222",
  accountId: "33333333-3333-4333-8333-333333333333",
  provider: { provider: "enveo" as const, model: "gpt-test" },
  locale: "pl-PL",
  tier: "plain" as const,
  epoch: 0,
  images: [
    { mimeType: "image/png", content: new Uint8Array([1, 2, 3]) },
    { mimeType: "image/jpeg", content: new Uint8Array([4, 5]) },
  ],
});

describe("durable import request identity", () => {
  test("hashes canonical metadata and ordered image content", () => {
    // given: a decoded request whose image bytes have known SHA-256 digests
    const input = request();

    // when: the repository derives its idempotency identity
    const identity = computeImportJobRequestHash(input);

    // then: it matches the hand-derived versioned canonical tuple digest
    expect(identity).toBe("6900bc28551ac749e0195d45e151f37fe64d53739a58122574a579628057666b");
  });

  test("treats image order and request metadata as part of request identity", () => {
    // given: one durable request
    const original = request();

    // when: either its ordered screenshots or locale changes
    const reversed = { ...original, images: [...original.images].reverse() };
    const translated = { ...original, locale: "en-GB" };

    // then: neither request can alias the original idempotency identity
    expect(computeImportJobRequestHash(reversed)).not.toBe(computeImportJobRequestHash(original));
    expect(computeImportJobRequestHash(translated)).not.toBe(computeImportJobRequestHash(original));
  });
});
