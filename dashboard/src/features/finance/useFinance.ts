import { subscribeChanges } from "../../core/events";
import { useCallback, useEffect, useState } from "react";
import { api, isDemo } from "../../core/store";

export interface FinCard {
  id: string;
  name: string;
  last4?: string;
  note?: string;
  limitMinor: number;
  balanceMinor: number;
  availableMinor: number;
  usedPct: number;
  payMinor?: number;
  payNote?: string;
  cutDate?: string;
  cutNote?: string;
  dueDate?: string;
  dueEstimated: boolean;
  cycleStart?: string;
  cycleEnd?: string;
  cycleChargesMinor: number;
  daysToCut?: number;
  daysToDue?: number;
  asOf?: string;
  ageDays?: number;
  stale: boolean;
  cutPassed: boolean;
}
export interface FinTx {
  id: string;
  date: string;
  card: string;
  cardName?: string;
  desc: string;
  category?: string;
  amountMinor: number;
  type: "charge" | "payment" | "cashback" | "reversal";
  status?: "posted" | "pending";
  note?: string;
}
export interface FinInstallment {
  id: string;
  label: string;
  card?: string;
  originalMinor?: number;
  months: number;
  paid: number;
  left: number;
  monthlyMinor: number;
  remainingMinor: number;
  estimated?: boolean;
  done: boolean;
}
export interface FinAlert {
  level: "info" | "warning" | "danger";
  code: string;
  text: string;
  card?: string;
}
export interface FinanceOverview {
  configured: boolean;
  today?: string;
  reconciledAt?: string;
  expiresAt?: string;
  expired?: boolean;
  incomeMonthlyMinor?: number;
  totals?: {
    limitMinor: number;
    usedMinor: number;
    availableMinor: number;
    usedPct: number;
    payMinor: number;
    cycleChargesMinor: number;
  };
  cards?: FinCard[];
  flow?: {
    inflows: {
      id: string;
      label: string;
      kind: string;
      amountMinor: number;
      recurring: boolean;
      available?: string;
      note?: string;
    }[];
    inflowsMinor: number;
    payMinor: number;
    afterPayMinor: number;
    installmentsMonthlyMinor: number;
    fixedMinor: number;
    commitmentsMinor: number;
    marginMinor: number;
  };
  commitments?: {
    id: string;
    label: string;
    amountMinor: number;
    cardName?: string;
    note?: string;
  }[];
  installments?: FinInstallment[];
  installmentsRemainingMinor?: number;
  categories?: {
    category: string;
    amountMinor: number;
    pctOfIncome?: number;
  }[];
  leak?: {
    days: number;
    rows: { category: string; amountMinor: number }[];
    totalMinor: number;
    perDayMinor: number;
  };
  transactions?: FinTx[];
  upcoming?: {
    date: string;
    type: "cut" | "due";
    label: string;
    amountMinor?: number;
    estimated: boolean;
    overdue?: boolean;
  }[];
  alerts?: FinAlert[];
  questions?: { id: string; text: string; since?: string }[];
}

let cache: FinanceOverview | undefined;

export function useFinance() {
  const [data, setData] = useState<FinanceOverview | undefined>(cache);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      cache = await api<FinanceOverview>("/finance/overview");
      setData(cache);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    // The demo has no API: finance data comes from the local ledger.
    if (isDemo) return;
    void load();
    const stopEvents = subscribeChanges(() => void load());
    const visible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", visible);
    return () => {
      stopEvents();
      document.removeEventListener("visibilitychange", visible);
    };
  }, [load]);
  const run = useCallback(async (op: Record<string, unknown>) => {
    const response = await api<{ overview: FinanceOverview }>("/finance/ops", {
      method: "POST",
      body: JSON.stringify(op),
    });
    cache = response.overview;
    setData(cache);
    return response;
  }, []);
  return { data, error, run, reload: load };
}
