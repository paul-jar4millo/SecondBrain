import { z } from "zod";

/** Engines the launcher can run (launcher/engines.mjs CAPABILITIES). */
export const Engine = z.enum(["claude", "codex", "agy", "deepseek"]);
export type Engine = z.infer<typeof Engine>;

export const AgentRef = z.object({
  engine: Engine,
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
});
export type AgentRef = z.infer<typeof AgentRef>;
