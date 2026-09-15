export type PrivacyRule =
  | "iban"
  | "bic"
  | "routing-number"
  | "account-number"
  | "secret"
  | "private-provenance"
  | "known-value"
  | "binary-evidence"
  | "encoded-depth";

export type PrivacyViolation = Readonly<{ path: string; line: number; rule: PrivacyRule; detail: string }>;

const LABELED_IDENTIFIERS = [
  ["bic", /\b(?:BIC|SWIFT)(?:\s+code)?\s*[:=]\s*[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/gi],
  ["routing-number", /\b(?:ABA|routing(?:\s+number)?)\s*[:=]\s*\d{9}\b/gi],
  ["account-number", /\b(?:bank\s+)?account(?:\s+number|\s+no\.?)?\s*[:=]\s*\d[\d -]{4,32}\d\b/gi],
] as const;

const SECRETS = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
] as const;

const PRIVATE_PROVENANCE = [
  /\b(?:copied|taken|exported|extracted)\s+from\s+(?:the\s+)?(?:production|live|my|our|customer(?:'s)?)\s+(?:bank\s+)?(?:data|database|account|statement|screenshot|ledger)\b/gi,
  /\b(?:real|actual)\s+(?:customer|user|owner|production)\s+(?:bank\s+)?(?:data|account|statement|balance|transaction|screenshot|ledger)\b/gi,
] as const;

function validIban(candidate: string): boolean {
  const tokens = candidate.trim().split(/\s+/);
  return tokens.some((_, index) => validCompactIban(tokens.slice(0, index + 1).join("")));
}

function validCompactIban(value: string): boolean {
  const compact = value.toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    const digits = /\d/.test(character) ? character : String(character.charCodeAt(0) - 55);
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

function addMatches(
  violations: PrivacyViolation[],
  path: string,
  text: string,
  rule: PrivacyRule,
  pattern: RegExp,
  accept: (value: string) => boolean = () => true,
): void {
  for (const match of text.matchAll(pattern)) {
    if (!accept(match[0])) continue;
    violations.push({ path, line: lineAt(text, match.index), rule, detail: "possible private data (value redacted)" });
  }
}

function decodedTextDataUrls(text: string): string[] {
  const decoded: string[] = [];
  for (const match of text.matchAll(/data:(?:text\/[a-z0-9.+-]+|application\/(?:json|xml)|image\/svg\+xml)(?:;[^;,=]+=[^;,]*)*;base64,([A-Za-z0-9+/=]+)/gi)) {
    try {
      decoded.push(Buffer.from(match[1]!, "base64").toString("utf8"));
    } catch {}
  }
  return decoded;
}

export function checkPrivacy(path: string, text: string, knownValues: readonly string[] = [], decodedDepth = 0): PrivacyViolation[] {
  const violations: PrivacyViolation[] = [];
  addMatches(violations, path, text, "iban", /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/gi, validIban);
  for (const [rule, pattern] of LABELED_IDENTIFIERS) {
    addMatches(violations, path, text, rule, pattern, (value) => rule !== "bic" || !/[:=]\s*TEST[A-Z0-9]{4,7}$/i.test(value));
  }
  for (const pattern of SECRETS) {
    addMatches(violations, path, text, "secret", pattern, (value) => !/^sk-(?:test-|sentinel_|legacy-|server-generation-|live-should-never-)/i.test(value));
  }
  for (const pattern of PRIVATE_PROVENANCE) addMatches(violations, path, text, "private-provenance", pattern);
  const foldedText = text.toLowerCase();
  for (const value of knownValues) {
    if (!value) continue;
    const foldedValue = value.toLowerCase();
    let index = foldedText.indexOf(foldedValue);
    while (index >= 0) {
      violations.push({ path, line: lineAt(text, index), rule: "known-value", detail: "owner-known private value (value redacted)" });
      index = foldedText.indexOf(foldedValue, index + foldedValue.length);
    }
  }
  const decoded = decodedTextDataUrls(text);
  if (decodedDepth < 4) {
    for (const value of decoded) violations.push(...checkPrivacy(`${path} (decoded data URL)`, value, knownValues, decodedDepth + 1));
  } else if (decoded.length) {
    violations.push({ path, line: 1, rule: "encoded-depth", detail: "nested encoded text exceeds inspection depth (content not inspected)" });
  }
  return violations;
}

export function isBinary(bytes: Uint8Array): boolean {
  const signature = new TextDecoder().decode(bytes.subarray(0, 8));
  if (signature.startsWith("%PDF-") || signature.startsWith("GIF87a") || signature.startsWith("GIF89a")) return true;
  if (bytes.length >= 8 && bytes[0] === 0x89 && signature.slice(1) === "PNG\r\n\x1A\n") return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return true;
  }
  let controls = 0;
  for (const byte of bytes) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) controls++;
  }
  return controls > 1 && controls * 100 > bytes.length;
}

export function isAllowedBinaryAsset(path: string): boolean {
  return new Set([
    "docs/assets/app-demo.png",
    "packages/web/public/apple-touch-icon.png",
    "packages/web/public/icon-192.png",
    "packages/web/public/icon-512.png",
    "packages/web/public/icon-maskable-512.png",
  ]).has(path);
}

export function formatPrivacyViolations(violations: readonly PrivacyViolation[]): string {
  return violations.map((item) => `  ${item.path}:${item.line}  [${item.rule}] ${item.detail}`).join("\n");
}
