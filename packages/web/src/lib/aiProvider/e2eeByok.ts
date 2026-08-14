import { AI_VISION_TIMEOUT_MS, buildImportExtractPrompt, type ChatRequest, type OpenAiModel, parseImportExtractResponse } from "@enveo/shared";
import { api, type E2eeCredentialResponse } from "../api";
import { budgetSecretAadContext, decryptPayload, encryptPayload } from "../crypto";
import { getTierMeta, requireValidatedDek } from "../e2ee";
import { directChatJson } from "../openai";
import { type AiProvider, type AiStatus, capabilitiesForProvider, type ImportExtractInput, type ImportExtractResult } from "./contracts";

export interface E2eeByokDependencies {
  tier: "plain" | "e2ee";
  unlocked: boolean;
  budgetId: string;
  model: OpenAiModel;
  currentEpoch: () => number;
  requireDek: (expectedEpoch: number) => Uint8Array;
  get: (budgetId: string) => Promise<E2eeCredentialResponse>;
  save: (budgetId: string, expectedEpoch: number, ciphertext: string) => Promise<void>;
  remove: (budgetId: string, expectedEpoch: number) => Promise<void>;
  directChat: (key: string, model: OpenAiModel, request: ChatRequest, timeoutMs?: number) => Promise<string>;
}

export class E2eeByokProvider implements AiProvider {
  constructor(private readonly deps: E2eeByokDependencies) {}

  private expectedEpoch(): number {
    if (this.deps.tier !== "e2ee" || !this.deps.unlocked) throw new Error("locked");
    return this.deps.currentEpoch();
  }

  private validateRecord(record: E2eeCredentialResponse, epoch: number): void {
    if (record.budgetId !== this.deps.budgetId) throw new Error("budget_mismatch");
    if (record.epoch !== epoch) throw new Error("tier_mismatch");
  }

  private async withCredential<T>(use: (key: string) => Promise<T>): Promise<T> {
    const epoch = this.expectedEpoch();
    const record = await this.deps.get(this.deps.budgetId);
    this.validateRecord(record, epoch);
    if (!record.configured || !record.ciphertext) throw new Error("credential_not_configured");
    const dek = this.deps.requireDek(epoch);
    let plaintext = "";
    try {
      plaintext = await decryptPayload(record.ciphertext, dek, budgetSecretAadContext(this.deps.budgetId, epoch, "openai"));
      return await use(plaintext);
    } finally {
      plaintext = "";
      dek.fill(0);
    }
  }

  async status(): Promise<AiStatus> {
    if (this.deps.tier !== "e2ee") return { provider: "openai", code: "tier-unavailable", capabilities: new Set(), configured: false };
    if (!this.deps.unlocked) return { provider: "openai", code: "locked", capabilities: new Set(), configured: false };
    const epoch = this.expectedEpoch();
    const record = await this.deps.get(this.deps.budgetId);
    this.validateRecord(record, epoch);
    if (!record.configured) return { provider: "openai", code: "not-configured", capabilities: new Set(), configured: false };
    const key = this.deps.requireDek(epoch);
    key.fill(0);
    return { provider: "openai", code: "ready", capabilities: capabilitiesForProvider("openai"), configured: true };
  }

  async saveCredential(key: string): Promise<void> {
    if (!key.trim() || key.length > 4096) throw new Error("ai_key_invalid");
    const epoch = this.expectedEpoch();
    const dek = this.deps.requireDek(epoch);
    let plaintext = key;
    try {
      const ciphertext = await encryptPayload(plaintext, dek, budgetSecretAadContext(this.deps.budgetId, epoch, "openai"));
      await this.deps.save(this.deps.budgetId, epoch, ciphertext);
    } finally {
      plaintext = "";
      key = "";
      dek.fill(0);
    }
  }

  async removeCredential(): Promise<void> {
    const epoch = this.expectedEpoch();
    this.deps.requireDek(epoch).fill(0);
    await this.deps.remove(this.deps.budgetId, epoch);
  }

  async testConnection(): Promise<void> {
    await this.withCredential(async (key) => {
      await this.deps.directChat(key, this.deps.model, { messages: [{ role: "user", content: "Reply with OK." }] });
    });
  }

  complete(request: ChatRequest): Promise<string> {
    return this.withCredential((key) => this.deps.directChat(key, this.deps.model, request));
  }

  extractImport(input: ImportExtractInput): Promise<ImportExtractResult> {
    return this.withCredential(async (key) => {
      const today = new Date().toISOString().slice(0, 10);
      const currency = input.ledger.budgets[0]?.currency ?? "EUR";
      const raw = await this.deps.directChat(
        key,
        this.deps.model,
        buildImportExtractPrompt(input.images, { envelopes: [], categories: [] }, today, input.locale, currency),
        AI_VISION_TIMEOUT_MS,
      );
      const items = parseImportExtractResponse(raw).map((item) => ({
        ...item,
        name: item.rawPlace,
        envelopeId: null,
        envelopeName: null,
        categoryId: null,
        categoryName: null,
        placeName: null,
      }));
      return { items };
    });
  }
}

export function createE2eeByokProvider(budgetId: string, model: OpenAiModel, unlocked: boolean): E2eeByokProvider {
  return new E2eeByokProvider({
    tier: "e2ee",
    unlocked,
    budgetId,
    model,
    currentEpoch: () => getTierMeta().epoch,
    requireDek: requireValidatedDek,
    get: api.e2eeByokCredentialGet,
    save: async (id, epoch, ciphertext) => void (await api.e2eeByokCredentialSave(id, epoch, ciphertext)),
    remove: async (id, epoch) => void (await api.e2eeByokCredentialDelete(id, epoch)),
    directChat: (key, selectedModel, request, timeoutMs) => directChatJson(request, key, selectedModel, timeoutMs),
  });
}
