import type { ProviderAttachment } from "./lib/providers/shared.mjs";

export interface MotorOptions {
  modelo?: string | null;
  esfuerzo?: string | null;
  conversacionId?: string | null;
}

export type UsageWindowId = "5h" | "semanal";

export interface UsageWindow {
  usado: number | null;
  reinicia: string | null;
  agotada: boolean;
}

export type UsageWindows = Partial<Record<UsageWindowId, UsageWindow>>;

export interface StreamResult {
  sessionId: string | null;
  texto: string;
  error: string | null;
  usados: number | null;
  limite: number | null;
  compactado: boolean;
  ventanas: UsageWindows;
  terminado?: boolean;
}

interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface ClaudeRateLimit {
  utilization?: number;
  resetsAt?: number;
  status?: string;
}

export interface ClaudeStreamEvent {
  session_id?: string;
  type?: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  message?: {
    usage?: TokenUsage & {
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  rate_limit_info?: ClaudeRateLimit & {
    rateLimitType?: string;
    unifiedWindows?: Record<string, ClaudeRateLimit>;
  };
  result?: unknown;
  is_error?: boolean;
  modelUsage?: Record<string, { contextWindow?: number }>;
}

export interface GeminiStreamEvent {
  conversation_id?: string;
  event?: string;
  result?: {
    conversation_id?: string;
    status?: string;
    response?: unknown;
    error?: unknown;
  };
  step_update?: {
    state?: string;
    step_type?: string;
    usage?: TokenUsage & { cache_read_tokens?: number };
  };
}

export interface ToolActivityEvent {
  item?: { type?: string };
  params?: { item?: { type?: string } };
  message?: { content?: { type?: string; name?: string }[] };
  step_update?: { step_type?: string };
}

interface CodexUsageWindow {
  windowDurationMins?: number | null;
  window_minutes?: number;
  usedPercent?: number | null;
  used_percent?: number;
  resetsAt?: number | null;
  resets_at?: number;
}

export interface CodexUsageSnapshot {
  primary?: CodexUsageWindow | null;
  secondary?: CodexUsageWindow | null;
}

export type ClaudeUsageSnapshot = Partial<
  Record<
    "five_hour" | "seven_day",
    { used_percentage?: number; resets_at?: number }
  >
>;

interface QuotaBucket {
  remaining_fraction: number;
  reset_time?: string;
  disabled?: boolean;
}

export type AgyQuota = Partial<
  Record<`${"3p" | "gemini"}-${"5h" | "weekly"}`, QuotaBucket>
>;

export interface GeminiUsageGroup {
  buckets?: (QuotaBucket & { window: string; id?: string })[];
}

export interface DeepSeekBalance {
  is_available?: boolean;
  balance_infos?: { currency?: string; total_balance?: unknown }[];
}

export type FetchBalance = (
  url: string,
  options: RequestInit,
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface SessionCapabilitiesInput {
  motor: string;
  structured?: boolean;
  harness?: boolean;
  conversacionId?: string | null;
}

export interface RepoCapabilitiesInput {
  esRepo?: boolean;
  tieneRemoto?: boolean;
  remotoGithub?: boolean;
}

export type NormalizedAttachment = ProviderAttachment & { sha256?: string };
export type RawAttachment = Partial<
  Record<keyof NormalizedAttachment, unknown>
>;
