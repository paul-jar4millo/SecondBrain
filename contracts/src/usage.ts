import { z } from "zod";
import { Engine } from "./agents.ts";
import { Timestamp } from "./ids.ts";

export const TokenUsage = z.object({
  inputTokens: z.int().min(0),
  outputTokens: z.int().min(0),
  cachedInputTokens: z.int().min(0).optional(),
  reasoningTokens: z.int().min(0).optional(),
  costUsd: z.number().min(0).optional(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

/** One provider rate-limit window, normalised across engines. */
export const RateLimitWindow = z.object({
  window: z.string().min(1),
  usedPercent: z.number().min(0).max(100),
  resetsAt: Timestamp.nullable(),
  status: z.enum(["allowed", "warning", "rejected"]).optional(),
});
export type RateLimitWindow = z.infer<typeof RateLimitWindow>;

export const UsageSource = z.enum(["provider-event", "status-line", "api"]);

export const UsageSnapshot = z.object({
  engine: Engine,
  at: Timestamp,
  source: UsageSource,
  windows: z.array(RateLimitWindow),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshot>;
