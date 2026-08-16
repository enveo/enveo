import type { AiLocale, ChatRequest, ClientLedger, ImportRecognitionResult } from "@enveo/shared";

export type AiProviderKind = "rules" | "enveo" | "openai";
export type AiCapability = "budget-suggestion" | "custom-prompt" | "screenshot-import";

export type AiStatusCode = "ready" | "not-configured" | "operator-unavailable" | "tier-unavailable" | "locked" | "vault-unavailable";

export interface AiStatus {
  provider: AiProviderKind;
  code: AiStatusCode;
  capabilities: ReadonlySet<AiCapability>;
  configured: boolean;
}

export interface ImportExtractInput {
  images: string[];
  locale: AiLocale;
  ledger: ClientLedger;
  accountId: string;
}

export type ImportExtractResult = ImportRecognitionResult;

export interface AiProvider {
  status(): Promise<AiStatus>;
  saveCredential(key: string): Promise<void>;
  removeCredential(): Promise<void>;
  testConnection(): Promise<void>;
  complete(request: ChatRequest): Promise<string>;
  extractImport(input: ImportExtractInput): Promise<ImportExtractResult>;
}

const RULES_CAPABILITIES: ReadonlySet<AiCapability> = new Set(["budget-suggestion"]);
const MODEL_CAPABILITIES: ReadonlySet<AiCapability> = new Set(["budget-suggestion", "custom-prompt", "screenshot-import"]);

export function capabilitiesForProvider(provider: AiProviderKind): ReadonlySet<AiCapability> {
  return provider === "rules" ? RULES_CAPABILITIES : MODEL_CAPABILITIES;
}

export class UnsupportedCapabilityError extends Error {
  readonly code = "ai_capability_unsupported" as const;

  constructor(readonly capability: AiCapability) {
    super("ai_capability_unsupported");
    this.name = "UnsupportedCapabilityError";
  }
}
