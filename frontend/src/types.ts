export type UserRole = "USER" | "ADMIN";

export type DeclarationStatus = "PENDING" | "PROCESSING" | "APPROVED" | "REJECTED" | "FAILED";

export type AuthUser = {
  id: string;
  fullName?: string;
  full_name?: string;
  email: string;
  role: UserRole;
  walletAddress?: string | null;
  wallet_address?: string | null;
};

export type Declaration = {
  id: string;
  material: string;
  quantity: string;
  status: DeclarationStatus;
  description?: string | null;
  wallet_address?: string | null;
  estimated_reward_amount?: string | null;
  reward_amount?: string | null;
  declaration_key?: string;
  tx_hash?: string | null;
  last_error?: string | null;
  created_at?: string;
  full_name?: string;
  email?: string;
  user_wallet_address?: string | null;
};

export function displayName(user: AuthUser | null | undefined): string {
  if (!user) return "";
  return user.fullName || user.full_name || user.email;
}

export function displayWallet(user: AuthUser | null | undefined): string | null {
  if (!user) return null;
  return user.walletAddress || user.wallet_address || null;
}

export type ChallengeTaskStatus =
  | "TODO"
  | "IN_PROGRESS"
  | "SUBMITTED"
  | "PROCESSING"
  | "COMPLETED"
  | "REJECTED"
  | "FAILED";

export type ChallengeBonusStatus = "NONE" | "PENDING" | "PROCESSING" | "GRANTED" | "FAILED";

export type ChallengeTaskView = {
  progressId: string;
  taskId: string;
  dayOfWeek: number;
  dayLabel: string;
  title: string;
  description?: string | null;
  status: ChallengeTaskStatus;
  statusLabel: string;
  rewardEco: string;
  pointsEarnedEco: string;
  completedAt?: string | null;
  submittedAt?: string | null;
  txHash?: string | null;
  lastError?: string | null;
};

export type CurrentChallengeView = {
  enrollmentId?: string;
  challenge?: {
    id: string;
    title: string;
    week_start: string;
    week_end: string;
    bonus_reward_eco?: string;
    is_active?: boolean;
  } | null;
  tasks?: ChallengeTaskView[];
  progress?: {
    completedCount: number;
    totalTasks: number;
    percent: number;
    earnedEco: string;
    bonusStatus: ChallengeBonusStatus;
    bonusEco: string;
    bonusTxHash?: string | null;
    bonusLastError?: string | null;
    totalRewardsEco: string;
    weekCompleted: boolean;
    completedAt?: string | null;
    badgeCode?: string | null;
  };
  messages?: { weekComplete?: string | null };
  message?: string;
};

export type ChallengeHistoryItem = {
  enrollmentId: string;
  title: string;
  weekStart: string;
  weekEnd: string;
  completedTasks: number;
  totalTasks: number;
  bonusStatus: ChallengeBonusStatus;
  badgeCode?: string | null;
  completedAt?: string | null;
  finished: boolean;
};

export type UserBadge = {
  id: string;
  badge_code: string;
  label: string;
  earned_at: string;
  challenge_id?: string | null;
};

export type AdminChallengeSummary = {
  id: string;
  title: string;
  week_start: string;
  week_end: string;
  bonus_reward_eco?: string;
  is_active: boolean;
  enrollment_count?: number;
  task_count?: number;
};

export type AdminChallengeTask = {
  id: string;
  day_of_week: number;
  day_label?: string;
  title: string;
  description?: string | null;
  reward_eco: string;
};

export type AdminChallengeDetail = AdminChallengeSummary & {
  bonus_reward_wei?: string;
  tasks: AdminChallengeTask[];
};

export type ChallengeSubmission = {
  id: string;
  status: ChallengeTaskStatus;
  status_label?: string;
  task_title: string;
  challenge_title: string;
  day_label?: string;
  full_name?: string;
  email?: string;
  user_wallet?: string | null;
  reward_eco?: string;
  last_error?: string | null;
  tx_hash?: string | null;
  enrollment_id?: string;
};
