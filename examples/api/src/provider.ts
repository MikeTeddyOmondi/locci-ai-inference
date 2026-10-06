import { createLocci } from '@locci/ai-sdk';
import type { LanguageModel } from 'ai';

// Replaces locci-chat-cli's PROVIDER switch (anthropic / openai / groq): every
// model call goes through the Locci AI Gateway via @locci/ai-sdk, so these
// examples exercise the SDK the same way a real client would.
const DEFAULT_MODEL = 'qwen3-1.7b'; // the gateway's tool-calling model

export interface Resolved {
  provider: 'locci';
  modelId: string;
  model: LanguageModel;
  baseURL: string;
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

  const locci = createLocci({
    baseURL,
    authURL: process.env.LOCCI_AUTH_URL,
    apiKey: process.env.LOCCI_API_KEY,
    accessToken: process.env.LOCCI_ACCESS_TOKEN,
  });

  return { provider: 'locci', modelId, model: locci(modelId), baseURL };
}
