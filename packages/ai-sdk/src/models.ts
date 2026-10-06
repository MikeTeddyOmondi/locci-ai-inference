/**
 * Model ids the gateway serves. Must match `ModelRegistry` in
 * locci-ai-gateway/main.go; test/models.test.ts fails when they drift.
 *
 * The `(string & {})` arm keeps autocomplete for the known ids while still
 * accepting a model the gateway adds before this package is updated.
 */

/** `qwen3-1.7b` handles chat, code and tools; `qwen2.5-coder-1.5b` is code generation only (no tool calls). */
export const LOCCI_CHAT_MODELS = ["qwen3-1.7b", "qwen2.5-coder-1.5b", "baidu-ocr-vision"] as const;
export const LOCCI_EMBEDDING_MODELS = ["embedding-nomic"] as const;

export type LocciChatModelId = (typeof LOCCI_CHAT_MODELS)[number] | (string & {});
export type LocciEmbeddingModelId = (typeof LOCCI_EMBEDDING_MODELS)[number] | (string & {});
