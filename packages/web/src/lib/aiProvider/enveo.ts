import type { ChatRequest } from "@enveo/shared";
import { api } from "../api";
import { chatJson } from "../openai";
import {
  type AiProvider,
  type AiStatus,
  capabilitiesForProvider,
  type ImportExtractInput,
  type ImportExtractResult,
  UnsupportedCapabilityError,
} from "./contracts";

export interface EnveoAiDependencies {
  tier: "plain" | "e2ee";
  info: () => Promise<{ serverAi: boolean }>;
  complete: (request: ChatRequest) => Promise<string>;
  extract: (input: ImportExtractInput) => Promise<ImportExtractResult>;
}

export class EnveoAiProvider implements AiProvider {
  constructor(private readonly deps: EnveoAiDependencies) {}

  async status(): Promise<AiStatus> {
    if (this.deps.tier !== "plain") return { provider: "enveo", code: "tier-unavailable", capabilities: new Set(), configured: false };
    const info = await this.deps.info();
    return info.serverAi
      ? { provider: "enveo", code: "ready", capabilities: capabilitiesForProvider("enveo"), configured: true }
      : { provider: "enveo", code: "operator-unavailable", capabilities: new Set(), configured: false };
  }

  async saveCredential(_key: string): Promise<void> {
    throw new UnsupportedCapabilityError("custom-prompt");
  }

  async removeCredential(): Promise<void> {
    throw new UnsupportedCapabilityError("custom-prompt");
  }

  async testConnection(): Promise<void> {
    throw new UnsupportedCapabilityError("custom-prompt");
  }

  async complete(request: ChatRequest): Promise<string> {
    if (this.deps.tier !== "plain") throw new UnsupportedCapabilityError("custom-prompt");
    return this.deps.complete(request);
  }

  async extractImport(input: ImportExtractInput): Promise<ImportExtractResult> {
    if (this.deps.tier !== "plain") throw new UnsupportedCapabilityError("screenshot-import");
    return this.deps.extract(input);
  }
}

export function createEnveoAiProvider(tier: "plain" | "e2ee"): EnveoAiProvider {
  return new EnveoAiProvider({
    tier,
    info: api.aiInfo,
    complete: (request) => chatJson(request, { kind: "server" }),
    extract: ({ images, locale }) => api.importExtract(images, locale),
  });
}
