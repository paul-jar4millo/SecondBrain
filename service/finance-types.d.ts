export interface FinanceCard {
  id: string;
  name: string;
  last4?: string;
  limitMinor?: number;
  balanceMinor?: number;
  payMinor?: number;
  payNote?: string;
  cutDate?: string;
  cycleStart?: string;
  cutNote?: string;
  dueDate?: string;
  dueEstimated?: boolean;
  note?: string;
  asOf?: string;
}

export type FinanceTransactionType =
  "charge" | "payment" | "cashback" | "reversal";

export interface FinanceTransaction {
  id: string;
  date: string;
  card: string;
  desc: string;
  amountMinor: number;
  type: FinanceTransactionType;
  category?: string;
  status?: "pending" | "posted";
  note?: string;
  ref?: string;
}

export interface FinanceInstallment {
  id: string;
  label?: string;
  card?: string;
  originalMinor?: number;
  months?: number;
  monthlyMinor?: number;
  paid?: number;
  remainingMinor?: number;
  estimated?: boolean;
}

export interface FinanceCommitment {
  id: string;
  label?: string;
  amountMinor?: number;
  card?: string;
  dayOfMonth?: number;
  note?: string;
}

export interface FinanceCash {
  id: string;
  label?: string;
  kind?: string;
  amountMinor?: number;
  recurring?: boolean;
  available?: string;
  note?: string;
}

export interface FinanceQuestion {
  id: string;
  text: string;
  since?: string;
}

export interface FinanceData {
  schemaVersion: 1;
  currency: "MXN";
  reconciledAt?: string;
  validityDays: number;
  staleAfterDays: number;
  incomeMonthlyMinor: number;
  leakCategories: string[];
  cards: FinanceCard[];
  cash: FinanceCash[];
  commitments: FinanceCommitment[];
  installments: FinanceInstallment[];
  transactions: FinanceTransaction[];
  questions: FinanceQuestion[];
  source?: string;
}

export interface FinanceOperation extends Record<string, unknown> {
  op?: string;
  requestId?: string;
  category?: string;
  kind?: string;
  note?: string;
  payNote?: string;
  cutNote?: string;
}

export type FinanceHandler = (
  data: FinanceData,
  operation: FinanceOperation,
  today: string,
) => object;
