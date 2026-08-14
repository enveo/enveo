import type { ChatRequest, OpenAiModel } from "@enveo/shared";
import { api } from "../api";
import {
  type AiProvider,
  type AiStatus,
  capabilitiesForProvider,
  type ImportExtractInput,
  type ImportExtractResult,
  UnsupportedCapabilityError,
} from "./contracts";

export interface PlainByokDependencies {
  tier: "plain" | "e2ee";
  budgetId: string;
  model: OpenAiModel;
  status: (budgetId: string) => Promise<{ configured: boolean; available: boolean; reason?: string }>;
  save: (budgetId: string, key: string) => Promise<void>;
  remove: (budgetId: string) => Promise<void>;
  test: (budgetId: string, model: OpenAiModel) => Promise<void>;
  complete: (budgetId: string, model: OpenAiModel, request: ChatRequest) => Promise<string>;
  extract: (budgetId: string, model: OpenAiModel, input: ImportExtractInput) => Promise<ImportExtractResult>;
}

export class PlainByokProvider implements AiProvider {
  constructor(private readonly deps: PlainByokDependencies) {}

  async status(): Promise<AiStatus> {
    if (this.deps.tier !== "plain") return { provider: "openai", code: "tier-unavailable", capabilities: new Set(), configured: false };
    const status = await this.deps.status(this.deps.budgetId);
    if (!status.available) return { provider: "openai", code: "vault-unavailable", capabilities: new Set(), configured: status.configured };
    if (!status.configured) return { provider: "openai", code: "not-configured", capabilities: new Set(), configured: false };
    return { provider: "openai", code: "ready", capabilities: capabilitiesForProvider("openai"), configured: true };
  }

  async saveCredential(key: string): Promise<void> {
    if (this.deps.tier !== "plain") throw new UnsupportedCapabilityError("custom-prompt");
    await this.deps.save(this.deps.budgetId, key);
  }

  async removeCredential(): Promise<void> {
    if (this.deps.tier !== "plain") throw new UnsupportedCapabilityError("custom-prompt");
    await this.deps.remove(this.deps.budgetId);
  }

  async testConnection(): Promise<void> {
    if (this.deps.tier !== "plain") throw new UnsupportedCapabilityError("custom-prompt");
    await this.deps.test(this.deps.budgetId, this.deps.model);
  }

  async complete(request: ChatRequest): Promise<string> {
    if (this.deps.tier !== "plain") throw new UnsupportedCapabilityError("custom-prompt");
    return this.deps.complete(this.deps.budgetId, this.deps.model, request);
  }

  async extractImport(input: ImportExtractInput): Promise<ImportExtractResult> {
    if (this.deps.tier !== "plain") throw new UnsupportedCapabilityError("screenshot-import");
    return this.deps.extract(this.deps.budgetId, this.deps.model, input);
  }
}

export function createPlainByokProvider(tier: "plain" | "e2ee", budgetId: string, model: OpenAiModel): PlainByokProvider {
  return new PlainByokProvider({
    tier,
    budgetId,
    model,
    status: api.byokCredentialStatus,
    save: async (id, key) => void (await api.byokCredentialSave(id, key)),
    remove: async (id) => void (await api.byokCredentialDelete(id)),
    test: async (id, selectedModel) => void (await api.byokCredentialTest(id, selectedModel)),
    complete: async (id, selectedModel, request) => (await api.byokChat(id, selectedModel, request)).content,
    extract: (id, selectedModel, input) => api.byokImportExtract(id, selectedModel, input.images, input.locale),
  });
}
