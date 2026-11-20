import type { Engine } from "./thread-types";

export interface ThreadTarget {
  id?: string;
  engine?: Engine;
  projectId?: string;
  prompt?: string;
}
