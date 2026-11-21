// Cross review (phase B3). A review stage reports a verdict; when its turn
// ends the thread goes back to the implementer, waits for the owner, or
// asks the owner to decide once the rounds run out.
import type {
  AgentReview,
  ReviewFinding,
  Thread,
  ThreadStatus,
} from "../../../contracts/src/index.ts";
import { currentStage } from "./flows.ts";
import { handoffTargets } from "./handoff.ts";

export interface ReviewDecision {
  status?: ThreadStatus;
  notice?: string;
  handoff?: { index: number; narrative: string; openItems: string[] };
}

export const findingText = (finding: ReviewFinding) =>
  `${finding.severity}: ${
    finding.file
      ? `${finding.file}${finding.line ? `:${finding.line}` : ""} — `
      : ""
  }${finding.text}`;

export function isReviewStage(thread: Thread) {
  return currentStage(thread)?.role === "review";
}

/** What follows a review once the reviewer's turn has completed. */
export function reviewDecision(
  thread: Thread,
  review: AgentReview & { round: number },
): ReviewDecision {
  if (review.verdict === "approved") return { status: "ready-for-review" };
  if (review.verdict === "comment") return {};
  const max = thread.limits.maxReviewRounds;
  if (review.round >= max)
    return {
      status: "needs-decision",
      notice: `La revisión pidió cambios ${review.round} ${review.round === 1 ? "vez" : "veces"}, el máximo del flujo. Decide si sigues, cierras o descartas.`,
    };
  const target = handoffTargets(thread)
    .map((key) => thread.flow?.stages.findIndex((s) => s.key === key) ?? -1)
    .find((index) => index >= 0);
  if (target === undefined)
    return {
      status: "needs-decision",
      notice:
        "La revisión pidió cambios, pero el flujo no tiene a quién devolverlos.",
    };
  return {
    handoff: {
      index: target,
      narrative: `Revisión ${review.round} de ${max}: pide cambios.\n\n${review.summary}`,
      openItems: review.findings.map(findingText),
    },
  };
}
