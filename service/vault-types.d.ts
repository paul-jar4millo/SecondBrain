import type { split, types } from "./vault-format.mjs";

export type VaultKind = keyof typeof types;
export type VaultMetadata = Record<string, unknown>;

export interface VaultItem extends VaultMetadata {
  id: string;
  kind: VaultKind;
  title: string;
  body?: string;
  version?: string | number;
  createdAt?: string;
  updatedAt?: string;
  vaultPath?: string;
  sourceLine?: number;
  sourceKind?: string;
  status?: string;
  tags?: string[];
  area?: string;
  deleted?: boolean;
  validationErrors?: string[];
  date?: string;
  plannedDate?: string;
  startsAt?: string;
  dueDate?: string;
  recurrence?: string;
  recurrenceDay?: number;
  projectId?: string;
  externalId?: string;
  accountId?: string;
  otherAccountId?: string;
  category?: string;
  transactionType?: string;
  amountMinor?: number;
  priority?: boolean;
}

export interface VaultRecord {
  item: VaultItem;
  relative: string;
  text: string;
  parts: ReturnType<typeof split>;
  metadata: VaultMetadata;
  sb: VaultMetadata;
  fileHash: string;
  lineIndex?: number;
  line?: string;
  marker?: string;
}

export interface VaultIssue {
  path: string;
  message: string;
}

export interface VaultSnapshot {
  records: Map<string, VaultRecord>;
  byPath: Map<string, VaultRecord>;
  items: VaultItem[];
  issues: VaultIssue[];
}

export interface VaultMutation {
  mutationId: string;
  baseVersion: string | number;
  entity: VaultItem;
}

export interface JournalEntry {
  relative: string;
  before: string | null;
  afterHash: string;
}

export interface HistoryEntry {
  at: string;
  actor: string;
  path: string;
  before: string | null;
  after: string;
}
