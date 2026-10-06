/**
 * Model ids the gateway serves. Must match `ModelRegistry` in
 * locci-ai-gateway/main.go; test/models.test.ts fails when they drift.
 *
 * The `(string & {})` arm keeps autocomplete for the known ids while still
 * accepting a model the gateway adds before this package is updated.
 */

export const LOCCI_CHAT_MODELS = ["qwen-coder-7b", "qwen-coder-14b", "baidu-ocr-vision"] as const;
export const LOCCI_EMBEDDING_MODELS = ["embedding-nomic"] as const;

export type LocciChatModelId = (typeof LOCCI_CHAT_MODELS)[number] | (string & {});
export type LocciEmbeddingModelId = (typeof LOCCI_EMBEDDING_MODELS)[number] | (string & {});
