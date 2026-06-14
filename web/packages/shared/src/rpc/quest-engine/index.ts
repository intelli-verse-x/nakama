import { callRpc, type RpcOptions } from "../client";

export interface QuestStepConfig {
  id: string;
  description?: string;
  eventType: string;
  requiredCount: number;
  requiredValue?: number;
}

export interface QuestConfig {
  id: string;
  name: string;
  description?: string;
  category?: "daily" | "weekly" | "monthly" | "friend" | string;
  repeatable?: boolean;
  resetIntervalSec?: number;
  steps: QuestStepConfig[];
  reward?: {
    currencies?: Record<string, number>;
    items?: Array<{ id: string; count: number }>;
    xp?: number;
  };
  startTimeSec?: number;
  endTimeSec?: number;
  disabled?: boolean;
  sortOrder?: number;
  metadata?: Record<string, unknown>;
}

export interface QuestsConfig {
  quests: Record<string, QuestConfig>;
}

export interface QuestProgress {
  id: string;
  name: string;
  description?: string;
  category?: string;
  steps: Array<{
    id: string;
    description?: string;
    eventType: string;
    requiredCount: number;
    requiredValue?: number;
    currentCount: number;
    completed: boolean;
  }>;
  reward?: QuestConfig["reward"];
  completedAt?: number;
  claimedAt?: number;
  resetsAt?: number;
}

export interface GetQuestsResponse {
  quests: QuestProgress[];
}

export interface RecordEventResponse {
  updatedQuests: number;
}

export interface ClaimRewardResponse {
  questId: string;
  reward: QuestConfig["reward"];
}

export async function getQuestConfig(
  opts: RpcOptions,
  gameId?: string,
): Promise<QuestsConfig> {
  const result = await callRpc<{ gameId?: string }, QuestsConfig>(
    "quest_engine_admin_get_config",
    { gameId },
    opts,
  );
  return result ?? { quests: {} };
}

export async function saveQuestConfig(
  config: QuestsConfig,
  opts: RpcOptions,
  gameId?: string,
): Promise<void> {
  await callRpc<{ gameId?: string; config: QuestsConfig }, void>(
    "quest_engine_admin_save_config",
    { gameId, config },
    opts,
  );
}

export async function getQuests(opts: RpcOptions, gameId?: string): Promise<GetQuestsResponse> {
  return callRpc<{ gameId?: string }, GetQuestsResponse>(
    "quest_engine_get",
    { gameId },
    opts,
  );
}

export async function recordEvent(
  eventType: string,
  count: number,
  value: number | undefined,
  opts: RpcOptions,
  gameId?: string,
): Promise<RecordEventResponse> {
  return callRpc<{ gameId?: string; eventType: string; count: number; value?: number }, RecordEventResponse>(
    "quest_engine_record_event",
    { gameId, eventType, count, value },
    opts,
  );
}

export async function claimReward(
  questId: string,
  opts: RpcOptions,
  gameId?: string,
): Promise<ClaimRewardResponse> {
  return callRpc<{ gameId?: string; questId: string }, ClaimRewardResponse>(
    "quest_engine_claim_reward",
    { gameId, questId },
    opts,
  );
}
