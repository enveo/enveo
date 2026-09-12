import {
  type ChatRequest,
  type ImportChunkState,
  type ImportHistoryRecord,
  type ImportRecognitionPipelineInput,
  type ImportRecognitionResult,
  type OpenAiModel,
  runImportRecognitionPipeline,
} from "@enveo/shared";
import { api, apiErrorBody, type E2eeCredentialResponse } from "../api";
import { budgetSecretAadContext, decryptPayload, encryptPayload } from "../crypto";
import * as e2ee from "../e2ee";
import { directChatJson } from "../openai";
import { store } from "../store";
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
  onTierMismatch: (meta: { tier: "plain" | "e2ee"; epoch: number; cipherVersion?: number }) => void;
}

export interface E2eeDurableImportInput extends Omit<ImportExtractInput, "images"> {
  /** Absolute screenshot positions; windows already read leave null behind. */
  images: ReadonlyArray<string | null>;
  checkpoint?: ImportRecognitionResult;
  chunks?: ImportChunkState[];
  lifecycle: NonNullable<ImportRecognitionPipelineInput["lifecycle"]>;
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

  private async serverCall<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const body = apiErrorBody(error);
      if (body?.error === "tier_mismatch" && (body.tier === "plain" || body.tier === "e2ee")) {
        this.deps.onTierMismatch({ tier: body.tier, epoch: body.epoch ?? 0, cipherVersion: body.cipherVersion });
        throw new Error("tier_mismatch");
      }
      throw error;
    }
  }

  private async withCredential<T>(use: (key: string) => Promise<T>): Promise<T> {
    const epoch = this.expectedEpoch();
    const record = await this.serverCall(() => this.deps.get(this.deps.budgetId));
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
    const record = await this.serverCall(() => this.deps.get(this.deps.budgetId));
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
      await this.serverCall(() => this.deps.save(this.deps.budgetId, epoch, ciphertext));
    } finally {
      plaintext = "";
      key = "";
      dek.fill(0);
    }
  }

  async removeCredential(): Promise<void> {
    const epoch = this.expectedEpoch();
    this.deps.requireDek(epoch).fill(0);
    await this.serverCall(() => this.deps.remove(this.deps.budgetId, epoch));
  }

  async testConnection(): Promise<void> {
    await this.withCredential(async (key) => {
      await this.deps.directChat(key, this.deps.model, { messages: [{ role: "user", content: "Reply with OK." }] });
    });
  }

  complete(request: ChatRequest): Promise<string> {
    return this.withCredential((key) => this.deps.directChat(key, this.deps.model, request));
  }

  private runImport(
    key: string,
    input: ImportExtractInput | E2eeDurableImportInput,
    durable?: Pick<E2eeDurableImportInput, "checkpoint" | "chunks" | "lifecycle">,
  ): Promise<ImportExtractResult> {
    const today = new Date().toISOString().slice(0, 10);
    const currency = input.ledger.budgets.find((budget) => budget.id === this.deps.budgetId)?.currency ?? "EUR";
    const envelopeNames = new Map(input.ledger.envelopes.map((envelope) => [envelope.id, envelope.name]));
    const categoryNames = new Map(input.ledger.categories.map((category) => [category.id, category.name]));
    const placeNames = new Map(input.ledger.places.map((place) => [place.id, place.name]));
    const historyRecords: ImportHistoryRecord[] = input.ledger.transactions.map((transaction) => ({
      accountId: transaction.accountId,
      currency,
      sourceRef: transaction.sourceRef,
      tag: transaction.tag,
      place: transaction.placeId ? (placeNames.get(transaction.placeId) ?? null) : null,
      name: transaction.name,
      envelope: transaction.envelopeId ? (envelopeNames.get(transaction.envelopeId) ?? null) : null,
      category: transaction.categoryId ? (categoryNames.get(transaction.categoryId) ?? null) : null,
      type: transaction.type,
      isRefund: transaction.type === "expense" && transaction.isRefund,
      toAccountId: transaction.type === "transfer" ? transaction.toAccountId : null,
    }));
    return runImportRecognitionPipeline({
      images: input.images,
      locale: input.locale,
      today,
      budgetCurrency: currency,
      accountId: input.accountId,
      accounts: input.ledger.accounts,
      envelopes: input.ledger.envelopes,
      categories: input.ledger.categories,
      places: input.ledger.places,
      transactions: input.ledger.transactions,
      historyRecords,
      chat: (request, timeoutMs) => this.deps.directChat(key, this.deps.model, request, timeoutMs),
      ...(durable
        ? {
            checkpoint: durable.checkpoint,
            chunks: durable.chunks,
            pipelineMode: "durable" as const,
            cycleTwoFailureMode: "strict" as const,
            lifecycle: durable.lifecycle,
          }
        : {}),
    });
  }

  extractImport(input: ImportExtractInput): Promise<ImportExtractResult> {
    return this.withCredential((key) => this.runImport(key, input));
  }

  /** Device-local durable execution uses the same checkpoint-safe, strict Stage A mode as
   * the database worker while the decrypted Own OpenAI key remains request-scoped here. */
  runDurableImport(input: E2eeDurableImportInput): Promise<ImportExtractResult> {
    return this.withCredential((key) => this.runImport(key, input, input));
  }
}

export function createE2eeByokProvider(budgetId: string, model: OpenAiModel, unlocked: boolean): E2eeByokProvider {
  return new E2eeByokProvider({
    tier: "e2ee",
    unlocked,
    budgetId,
    model,
    currentEpoch: () => e2ee.getTierMeta().epoch,
    requireDek: e2ee.requireValidatedDek,
    get: api.e2eeByokCredentialGet,
    save: async (id, epoch, ciphertext) => void (await api.e2eeByokCredentialSave(id, epoch, ciphertext)),
    remove: async (id, epoch) => void (await api.e2eeByokCredentialDelete(id, epoch)),
    directChat: (key, selectedModel, request, timeoutMs) => directChatJson(request, key, selectedModel, timeoutMs),
    onTierMismatch: (meta) => {
      e2ee.setTierMeta({ tier: meta.tier, epoch: meta.epoch });
      if (meta.cipherVersion === 1 || meta.cipherVersion === 2) e2ee.setCipherVersion(meta.cipherVersion);
      e2ee.clearDek();
      if (meta.tier === "e2ee") store.setBootStatus("locked");
    },
  });
}
