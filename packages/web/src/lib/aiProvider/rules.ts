import type { ChatRequest } from "@enveo/shared";
import {
  type AiProvider,
  type AiStatus,
  capabilitiesForProvider,
  type ImportExtractInput,
  type ImportExtractResult,
  UnsupportedCapabilityError,
} from "./contracts";

export class RulesProvider implements AiProvider {
  async status(): Promise<AiStatus> {
    return { provider: "rules", code: "ready", capabilities: capabilitiesForProvider("rules"), configured: true };
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

  async complete(_request: ChatRequest): Promise<string> {
    throw new UnsupportedCapabilityError("custom-prompt");
  }

  async extractImport(_input: ImportExtractInput): Promise<ImportExtractResult> {
    throw new UnsupportedCapabilityError("screenshot-import");
  }
}
