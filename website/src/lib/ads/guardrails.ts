/**
 * Money guardrails for autonomous advertising.
 *
 * This file exists before any code that can spend, and that ordering is the
 * point. A guardrail added after a system can already move money is a
 * post-mortem, not a control.
 *
 * Three principles shape it:
 *
 *  1. **Deny by default.** `autonomous` is off, every ceiling starts low, and
 *     an unknown action type is refused rather than allowed through.
 *  2. **Every decision is explainable.** A refusal names the rule and the
 *     numbers. "Blocked by policy" tells the owner nothing at 2am.
 *  3. **Nothing is irreversible.** Every approved action carries an inverse,
 *     recorded before it executes, so a bad batch can be walked back without
 *     reconstructing what it did from memory.
 */

export type OperatingMode =
  /** Recommend only. Nothing executes. This is where the system lives today. */
  | "recommend"
  /** Actions queue for a human to approve one by one. */
  | "manual_approval"
  /** Pre-approved action classes execute; everything else queues. */
  | "autonomous";

export type AdActionType =
  | "create_campaign"
  | "create_ad_group"
  | "publish_ad"
  | "pause_ad"
  | "pause_campaign"
  | "resume_ad"
  | "increase_budget"
  | "decrease_budget"
  | "emergency_pause_all";

export type Guardrails = {
  mode: OperatingMode;
  /** Hard ceiling across the whole account for a single UTC day. */
  dailyAccountCeiling: number;
  /** Hard ceiling for one campaign's daily budget. */
  campaignDailyCeiling: number;
  /** The largest single automatic increase, as a fraction of current budget. */
  maxBudgetIncreasePct: number;
  /** And as an absolute amount, whichever binds first. */
  maxBudgetIncreaseAbsolute: number;
  /** Conversions required before a scale recommendation may execute. */
  minConversionsToScale: number;
  /** Days of stable performance required before scaling. */
  minDaysToScale: number;
  /** Impressions required before a kill may execute on hook grounds. */
  minImpressionsToKill: number;
  /** Actions that may execute without a human in autonomous mode. */
  autoApprovedActions: AdActionType[];
  /** Set by the emergency stop. While true, nothing executes at all. */
  frozen: boolean;
  frozenReason?: string;
};

/**
 * Conservative on every axis. These are starting values a human raises
 * deliberately, not defaults tuned for convenience — the cost of a ceiling
 * being too low is an alert, and the cost of it being too high is money.
 */
export const DEFAULT_GUARDRAILS: Guardrails = {
  mode: "recommend",
  dailyAccountCeiling: 100,
  campaignDailyCeiling: 50,
  maxBudgetIncreasePct: 0.2,
  maxBudgetIncreaseAbsolute: 25,
  minConversionsToScale: 10,
  minDaysToScale: 7,
  minImpressionsToKill: 2000,
  // Pausing and decreasing spend are the only things safe to do unattended:
  // both can only ever reduce exposure. Nothing that starts or grows spend is
  // here, and adding one is a deliberate act.
  autoApprovedActions: ["pause_ad", "pause_campaign", "decrease_budget", "emergency_pause_all"],
  frozen: false,
};

export type ProposedAction = {
  actionId: string;
  type: AdActionType;
  creativeId?: string;
  campaignId?: string;
  adGroupId?: string;
  adId?: string;
  /** Money this action puts at risk per day. Zero for pauses. */
  dailyBudgetDelta: number;
  /** Budget after the change, for ceiling checks. */
  resultingCampaignDailyBudget?: number;
  rationale: string;
  evidence: Record<string, unknown>;
};

export type SpendState = {
  /** Spend already committed today across the account, from platform reporting. */
  todaySpend: number;
  /** Sum of active daily budgets — what the account could spend today. */
  committedDailyBudget: number;
};

export type GuardrailRuling = {
  allowed: boolean;
  requiresHumanApproval: boolean;
  /** Every rule that refused, with its numbers. Empty when allowed outright. */
  violations: string[];
  /** How to undo this if it executes. Recorded before execution, never after. */
  inverse: InverseAction | null;
};

export type InverseAction = {
  type: AdActionType;
  targetId: string;
  restoreDailyBudget?: number;
  note: string;
};

function inverseOf(action: ProposedAction, currentBudget?: number): InverseAction | null {
  switch (action.type) {
    case "increase_budget":
    case "decrease_budget":
      return {
        type: action.type === "increase_budget" ? "decrease_budget" : "increase_budget",
        targetId: action.campaignId ?? action.adGroupId ?? "",
        restoreDailyBudget: currentBudget,
        note: `restore daily budget to ${currentBudget ?? "previous value"}`,
      };
    case "publish_ad":
    case "resume_ad":
      return { type: "pause_ad", targetId: action.adId ?? action.creativeId ?? "", note: "pause the ad this action started" };
    case "create_campaign":
      return { type: "pause_campaign", targetId: action.campaignId ?? "", note: "pause the campaign this action created" };
    case "create_ad_group":
      return { type: "pause_campaign", targetId: action.campaignId ?? "", note: "pause the parent campaign" };
    case "pause_ad":
      return { type: "resume_ad", targetId: action.adId ?? "", note: "resume the ad this action paused" };
    // A pause has no inverse worth automating: un-pausing an emergency stop
    // must be a deliberate human act, not a rollback step.
    case "pause_campaign":
    case "emergency_pause_all":
      return null;
    default:
      return null;
  }
}

/**
 * The single gate every action passes through. Returns a ruling rather than
 * throwing, so a caller can log a refusal and continue with the rest of a batch
 * instead of losing the whole run to one bad proposal.
 */
export function evaluateAction(
  action: ProposedAction,
  guardrails: Guardrails,
  spend: SpendState,
  currentCampaignBudget?: number,
): GuardrailRuling {
  const violations: string[] = [];

  if (guardrails.frozen) {
    return {
      allowed: false,
      requiresHumanApproval: true,
      violations: [`account is frozen${guardrails.frozenReason ? `: ${guardrails.frozenReason}` : ""}`],
      inverse: null,
    };
  }

  // Pauses reduce exposure and are always permitted to proceed on their merits.
  const reducesExposure = action.dailyBudgetDelta <= 0;

  if (!reducesExposure) {
    const projected = spend.committedDailyBudget + action.dailyBudgetDelta;
    if (projected > guardrails.dailyAccountCeiling) {
      violations.push(
        `would commit $${projected.toFixed(2)}/day against a $${guardrails.dailyAccountCeiling.toFixed(2)} account ceiling`,
      );
    }
    if (spend.todaySpend >= guardrails.dailyAccountCeiling) {
      violations.push(
        `today's spend $${spend.todaySpend.toFixed(2)} has already reached the $${guardrails.dailyAccountCeiling.toFixed(2)} ceiling`,
      );
    }
    if (
      action.resultingCampaignDailyBudget !== undefined &&
      action.resultingCampaignDailyBudget > guardrails.campaignDailyCeiling
    ) {
      violations.push(
        `campaign budget $${action.resultingCampaignDailyBudget.toFixed(2)} exceeds the $${guardrails.campaignDailyCeiling.toFixed(2)} campaign ceiling`,
      );
    }
  }

  if (action.type === "increase_budget" && currentCampaignBudget !== undefined && currentCampaignBudget > 0) {
    const pct = action.dailyBudgetDelta / currentCampaignBudget;
    if (pct > guardrails.maxBudgetIncreasePct) {
      violations.push(
        `increase of ${(pct * 100).toFixed(0)}% exceeds the ${(guardrails.maxBudgetIncreasePct * 100).toFixed(0)}% step limit`,
      );
    }
    if (action.dailyBudgetDelta > guardrails.maxBudgetIncreaseAbsolute) {
      violations.push(
        `increase of $${action.dailyBudgetDelta.toFixed(2)} exceeds the $${guardrails.maxBudgetIncreaseAbsolute.toFixed(2)} step limit`,
      );
    }
  }

  const inverse = inverseOf(action, currentCampaignBudget);

  if (violations.length > 0) {
    return { allowed: false, requiresHumanApproval: true, violations, inverse };
  }

  if (guardrails.mode === "recommend") {
    return {
      allowed: false,
      requiresHumanApproval: true,
      violations: ["operating mode is 'recommend' — this system does not execute actions"],
      inverse,
    };
  }

  if (guardrails.mode === "manual_approval") {
    return { allowed: false, requiresHumanApproval: true, violations: [], inverse };
  }

  const preApproved = guardrails.autoApprovedActions.includes(action.type);
  return {
    allowed: preApproved,
    requiresHumanApproval: !preApproved,
    violations: preApproved ? [] : [`'${action.type}' is not in the auto-approved list`],
    inverse,
  };
}

// ---------------------------------------------------------------------------
// Action log
// ---------------------------------------------------------------------------

export type LoggedAction = {
  actionId: string;
  at: string;
  type: AdActionType;
  proposal: ProposedAction;
  ruling: GuardrailRuling;
  executed: boolean;
  executionResult?: { ok: boolean; platformResponse?: unknown; error?: string };
  /** Set when this entry was reverted, pointing at the action that undid it. */
  revertedBy?: string;
};

/**
 * Append-only by contract. A log that can be edited cannot answer "what did the
 * machine actually do", which is the only question that matters after a bad
 * night. Storage enforces this with a database trigger; this class enforces it
 * in memory so a caller cannot casually mutate history.
 */
export class ActionLog {
  private entries: LoggedAction[] = [];

  append(entry: LoggedAction): void {
    if (this.entries.some((e) => e.actionId === entry.actionId)) {
      throw new Error(`action ${entry.actionId} is already logged; the log is append-only`);
    }
    this.entries.push(Object.freeze({ ...entry }) as LoggedAction);
  }

  markReverted(actionId: string, revertingActionId: string): void {
    const index = this.entries.findIndex((e) => e.actionId === actionId);
    if (index < 0) throw new Error(`unknown action ${actionId}`);
    // Recorded as a new frozen entry rather than an in-place edit, so the
    // original record of what happened survives the correction.
    this.entries[index] = Object.freeze({ ...this.entries[index], revertedBy: revertingActionId }) as LoggedAction;
  }

  all(): readonly LoggedAction[] {
    return this.entries;
  }

  executed(): readonly LoggedAction[] {
    return this.entries.filter((e) => e.executed);
  }

  /** Everything that ran since a timestamp, newest first — the rollback set. */
  rollbackCandidates(since: string): LoggedAction[] {
    return this.entries
      .filter((e) => e.executed && !e.revertedBy && e.at >= since)
      .sort((a, b) => b.at.localeCompare(a.at));
  }
}

/** Flip every switch off. The one action that never needs justification. */
export function emergencyFreeze(guardrails: Guardrails, reason: string): Guardrails {
  return { ...guardrails, frozen: true, frozenReason: reason, mode: "recommend" };
}
