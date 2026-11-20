import { z } from "zod";
import { AgentRef } from "./agents.ts";
import { StageId } from "./ids.ts";

export const StageRole = z.enum(["plan", "implement", "review", "custom"]);
export type StageRole = z.infer<typeof StageRole>;

export const FlowTemplateStage = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  name: z.string().min(1),
  role: StageRole,
  readOnly: z.boolean(),
  defaultAgent: AgentRef.optional(),
});

export const HandoffRule = z.object({ from: z.string(), to: z.string() });

export const FlowTemplate = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    name: z.string().min(1),
    description: z.string(),
    stages: z.array(FlowTemplateStage).min(1),
    handoffs: z.array(HandoffRule),
    maxReviewRounds: z.int().min(0).max(3),
  })
  .superRefine((flow, ctx) => {
    const keys = new Set(flow.stages.map((s) => s.key));
    if (keys.size !== flow.stages.length)
      ctx.addIssue({ code: "custom", message: "Stage keys must be unique" });
    for (const rule of flow.handoffs)
      if (!keys.has(rule.from) || !keys.has(rule.to))
        ctx.addIssue({
          code: "custom",
          message: `Handoff ${rule.from}→${rule.to} names an unknown stage`,
        });
  });
export type FlowTemplate = z.infer<typeof FlowTemplate>;

/** A stage frozen into a thread when it is created. */
export const ThreadStage = z.object({
  id: StageId,
  key: z.string(),
  name: z.string(),
  role: StageRole,
  readOnly: z.boolean(),
  agent: AgentRef,
});
export type ThreadStage = z.infer<typeof ThreadStage>;

export const ThreadFlow = z.object({
  templateId: z.string(),
  stages: z.array(ThreadStage).min(1),
  handoffs: z.array(HandoffRule),
  maxReviewRounds: z.int().min(0).max(3),
});
export type ThreadFlow = z.infer<typeof ThreadFlow>;
