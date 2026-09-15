import { describe, expect, it } from "bun:test";
import { checkPrivacy, formatPrivacyViolations, isAllowedBinaryAsset, isBinary } from "./privacyPolicy";

function syntheticValidIban(): string {
  const bban = "TEST12345678901234";
  const numeric = `${bban}GB00`
    .split("")
    .map((character) => (/\d/.test(character) ? character : String(character.charCodeAt(0) - 55)))
    .join("");
  let remainder = 0;
  for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
  return `GB${String(98 - remainder).padStart(2, "0")}${bban}`;
}

describe("checkPrivacy", () => {
  it("detects plausible financial identifiers without echoing them", () => {
    const iban = syntheticValidIban();
    const routing = "000000000";
    const result = checkPrivacy("notes.txt", `IBAN: ${iban}\nrouting number: ${routing}\naccount number: 123456789012`);

    expect(result.map((item) => item.rule)).toEqual(["iban", "routing-number", "account-number"]);
    const report = formatPrivacyViolations(result);
    expect(report).not.toContain(iban);
    expect(report).not.toContain(routing);
    expect(report).not.toContain("123456789012");
    expect(checkPrivacy("statement.txt", `${iban} TOTAL OUTCOME CLOSING BALANCE`).map((item) => item.rule)).toContain("iban");
  });

  it("detects common secret formats and private-data provenance claims", () => {
    const token = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
    const provenance = ["copied from", "production bank statement"].join(" ");
    const result = checkPrivacy("fixture.ts", `const token = "${token}"; // ${provenance}`);
    expect(result.map((item) => item.rule)).toEqual(["secret", "private-provenance"]);
  });

  it("does not blacklist ordinary names, amounts, fictional US labels, or currency coverage", () => {
    expect(
      checkPrivacy(
        "fixture.ts",
        'const owner = "Jordan Example"; const balance = 12345; const bank = "Example Community Bank"; const currencies = ["USD", "PLN", "EUR"];',
      ),
    ).toEqual([]);
    expect(checkPrivacy("fixture.txt", "BIC/SWIFT: TESTUS00")).toEqual([]);
  });

  it("checks decoded text data URLs", () => {
    const encoded = Buffer.from(`IBAN: ${syntheticValidIban()}`).toString("base64");
    expect(checkPrivacy("fixture.json", `{"page":"data:text/plain;base64,${encoded}"}`).map((item) => item.rule)).toEqual(["iban"]);
  });

  it("checks encoded JSON and SVG data URLs without exposing their contents", () => {
    const token = ["github", "pat", "synthetic".repeat(5)].join("_");
    for (const [mime, value] of [
      ["application/json", JSON.stringify({ token })],
      ["image/svg+xml", `<svg><text>${token}</text></svg>`],
    ]) {
      const encoded = Buffer.from(value!).toString("base64");
      const result = checkPrivacy("fixture.txt", `data:${mime};base64,${encoded}`);
      expect(result.map((item) => item.rule)).toEqual(["secret"]);
      expect(formatPrivacyViolations(result)).not.toContain(token);
    }
  });

  it("matches an owner corpus without exposing its values", () => {
    const privateValue = "owner-only-known-value";
    const result = checkPrivacy("fixture.txt", `prefix ${privateValue.toUpperCase()} suffix`, [privateValue]);
    expect(result.map((item) => item.rule)).toEqual(["known-value"]);
    expect(formatPrivacyViolations(result)).not.toContain(privateValue);
  });
});

describe("isAllowedBinaryAsset", () => {
  it("allows only the established app icons and reviewed demo screenshot", () => {
    expect(isAllowedBinaryAsset("docs/assets/app-demo.png")).toBe(true);
    expect(isAllowedBinaryAsset("packages/web/public/icon-192.png")).toBe(true);
    expect(isAllowedBinaryAsset("packages/web/public/icon-new.png")).toBe(false);
    expect(isAllowedBinaryAsset("docs/assets/test-evidence.png")).toBe(false);
    expect(isAllowedBinaryAsset("scripts/fixtures/statement.pdf")).toBe(false);
  });
});

it("does not call valid UTF-8 binary when the old sample boundary splits a character", () => {
  expect(isBinary(new TextEncoder().encode(`${"a".repeat(8_191)}€`))).toBe(false);
});

it("allows an isolated NUL delimiter in otherwise textual source", () => {
  expect(isBinary(new TextEncoder().encode(`${"const value = 'text';".repeat(20)}\0end`))).toBe(false);
});

it("recognizes common binary signatures even when their bytes are valid UTF-8", () => {
  expect(isBinary(new TextEncoder().encode("%PDF-1.7 synthetic"))).toBe(true);
  expect(isBinary(new TextEncoder().encode("GIF89a synthetic"))).toBe(true);
});

it("flags encoded text nested past the inspection bound", () => {
  let text = "synthetic";
  for (let index = 0; index < 6; index++) text = `data:text/plain;base64,${Buffer.from(text).toString("base64")}`;
  expect(checkPrivacy("nested.txt", text).map((item) => item.rule)).toContain("encoded-depth");
});
