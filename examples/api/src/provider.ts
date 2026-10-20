import { createLocci, listModels, LOCCI_EMBEDDING_MODELS, type LocciProviderSettings } from '@locci/ai-sdk';
import type { LanguageModel } from 'ai';

// Replaces locci-chat-cli's PROVIDER switch (anthropic / openai / groq): every
// model call goes through the Locci AI Gateway via @locci/ai-sdk, so these
// examples exercise the SDK the same way a real client would.
const DEFAULT_MODEL = 'gemma-4-e2b'; // the pool `just up` starts

export interface Resolved {
  provider: 'locci';
  modelId: string;
  model: LanguageModel;
  baseURL: string;
  /** Any other gateway model, for clients that let the user pick one. */
  modelFor: (id: string) => LanguageModel;
  /** The gateway's chat models, described for a picker. */
  chatModels: () => Promise<ChatModel[]>;
}

/** A chat model as the web picker shows it. */
export interface ChatModel {
  id: string;
  description: string;
  /** Can call tools (weather, search, MCP); otherwise tools are left off. */
  tools: boolean;
  /** Reads images sent as file parts; other models get a note in their place. */
  images?: boolean;
  /** Needs input the clients can't send yet (images), so not selectable. */
  disabled?: boolean;
}

/**
 * What each gateway model is for. The ids come from the gateway; this only
 * adds words. A model the gateway adds later still lists, as a plain chat model.
 */
const MODEL_INFO: Record<string, Omit<ChatModel, 'id'> & { contextTokens?: number; thinkWithTools?: boolean }> = {
  // Context per request = llama-server -c / --parallel (compose.yaml).
  'qwen3-1.7b': { description: 'Chat, code and tools', tools: true, contextTokens: 16384 },
  'qwen2.5-coder-1.5b': { description: 'Code generation, no tools', tools: false, contextTokens: 2048 },
  // No thinkWithTools: with the write_file rule and the unchanged-write guard,
  // CLI file edits passed as often without thinking (6/8 and 3/3, as with it)
  // at ~2.5x the speed (BACKLOG.md). /think on still turns it on.
  'gemma-4-e2b': { description: 'Chat, tools and images', tools: true, images: true, contextTokens: 32768 },
  // Needs a task prompt (`OCR:`) rather than a question, and minutes per image on CPU.
  'baidu-ocr-vision': { description: 'Document OCR (API only)', tools: false, disabled: true },
};

/**
 * Tokens one request may use on a model. MODEL_CONTEXT_TOKENS overrides it for
 * the configured MODEL (set it when you change CODER_CTX or CODER_PARALLEL).
 */
export function contextTokensFor(id: string): number {
  const configured = Number(process.env.MODEL_CONTEXT_TOKENS);
  if (configured > 0 && id === (process.env.MODEL ?? DEFAULT_MODEL)) return configured;
  return MODEL_INFO[id]?.contextTokens ?? 8192;
}

/** Whether a model should think on a turn where a client runs tools (measured per model). */
export function thinksWithTools(id: string): boolean {
  return MODEL_INFO[id]?.thinkWithTools ?? false;
}

/** Whether a model reads images; unknown ids don't, to be safe. */
export function supportsImages(id: string): boolean {
  return MODEL_INFO[id]?.images ?? false;
}

/** Whether a model may be given tools; unknown ids get none, to be safe. */
export function supportsTools(id: string): boolean {
  return MODEL_INFO[id]?.tools ?? false;
}

/**
 * Reads MODEL and the LOCCI_* settings from the environment and returns a
 * ready-to-use model. Credentials: LOCCI_API_KEY (exchanged for short-lived
 * access tokens by the SDK) or LOCCI_ACCESS_TOKEN (sent as-is).
 */
export function resolveModel(): Resolved {
  const modelId = process.env.MODEL ?? DEFAULT_MODEL;
  const baseURL = process.env.LOCCI_AI_BASE_URL ?? 'http://localhost:8080/v1';

  if (!process.env.LOCCI_API_KEY && !process.env.LOCCI_ACCESS_TOKEN) {
    console.warn(
      '⚠️  Neither LOCCI_API_KEY nor LOCCI_ACCESS_TOKEN is set: gateway requests will fail until one is in .env',
    );
  }

  const settings: LocciProviderSettings = {
    baseURL,
    authURL: process.env.LOCCI_AUTH_URL,
    apiKey: process.env.LOCCI_API_KEY,
    accessToken: process.env.LOCCI_ACCESS_TOKEN,
  };
  const locci = createLocci(settings);

  // The gateway's list changes only on deploy; cache it for a minute.
  let cached: { at: number; models: ChatModel[] } | undefined;
  const embeddings = new Set<string>(LOCCI_EMBEDDING_MODELS);
  async function chatModels(): Promise<ChatModel[]> {
    if (cached && Date.now() - cached.at < 60_000) return cached.models;
    const ids = (await listModels(settings)).map((m) => m.id).filter((id) => !embeddings.has(id));
    if (!ids.includes(modelId)) ids.unshift(modelId);
    const models = ids.map((id): ChatModel => {
      const { description, tools, images, disabled } = MODEL_INFO[id] ?? { description: 'Chat', tools: false };
      return { id, description, tools, ...(images ? { images } : {}), ...(disabled ? { disabled } : {}) };
    });
    // Default first, unavailable last, the rest as the gateway lists them.
    const rank = (m: ChatModel) => (m.id === modelId ? 0 : m.disabled ? 2 : 1);
    models.sort((a, b) => rank(a) - rank(b));
    cached = { at: Date.now(), models };
    return models;
  }

  return {
    provider: 'locci',
    modelId,
    model: locci(modelId),
    baseURL,
    modelFor: (id) => locci(id),
    chatModels,
  };
}
