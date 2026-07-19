import { callRpc, type RpcOptions } from "../client";

export interface RevenueCatOverview {
  mrr: number;
  revenue28d: number;
  activeSubscriptions: number;
  activeTrials: number;
}

export interface RevenueCatDailyPoint {
  date: string;
  revenue: number;
  transactions: number;
}

export interface AdRevenueDailyPoint {
  date: string;
  revenue: number;
}

export interface RevenueCatAdRevenueStatus {
  status: "pending" | "live" | "error";
  source?: string;
  message: string;
  total?: number;
  daily?: AdRevenueDailyPoint[];
}

export interface StripeRevenueDailyPoint {
  date: string;
  revenue: number;
  transactions: number;
}

export interface StripeRevenueStatus {
  status: "pending" | "live" | "error";
  source?: string;
  message: string;
  total?: number;
  transactions?: number;
  daily?: StripeRevenueDailyPoint[];
  configured?: boolean;
  error?: string;
  filteredByPrice?: boolean;
}

export interface RevenueCatDashboardResult {
  source: "revenuecat" | "partial";
  currency: string;
  projectId: string;
  days: number;
  dateRange: { start: string; end: string };
  iapConfigured?: boolean;
  iapError?: string;
  overview: RevenueCatOverview;
  daily: RevenueCatDailyPoint[];
  totals: {
    revenue: number;
    transactions: number;
    stripeRevenue?: number;
    adRevenue?: number;
    combined?: number;
  };
  stripeRevenue?: StripeRevenueStatus;
  adRevenue: RevenueCatAdRevenueStatus;
}

function unwrapData<T>(value: unknown): T {
  if (
    value &&
    typeof value === "object" &&
    "success" in value &&
    "data" in value
  ) {
    return (value as { data: T }).data;
  }
  return value as T;
}

export function fetchRevenueCatDashboard(
  opts: RpcOptions,
  days = 30,
): Promise<RevenueCatDashboardResult> {
  return callRpc<{ days: number }, RevenueCatDashboardResult>(
    "admin_revenuecat_dashboard",
    { days },
    opts,
  ).then((value) => unwrapData<RevenueCatDashboardResult>(value));
}
