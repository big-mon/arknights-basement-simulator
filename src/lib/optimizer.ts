import { operators } from "../data/defaults";
import type {
  AppState,
  Assignment,
  AssignmentPlan,
  BaseSkill,
  BaseSkillEffect,
  FacilityPlan,
  FacilitySlot,
  Operator,
  OptimizationPreference,
  ProductType,
  RosterEntry
} from "../types";

const fatigueHoursByFacility: Record<FacilitySlot["type"], number> = {
  factory: 12,
  trading: 12,
  power: 18,
  control: 24,
  dormitory: 0
};

const recoveryBaseHours = 8;

export function generateAssignmentPlan(state: AppState): AssignmentPlan {
  const usedOperatorIds = new Set<string>();
  const facilityPlans: FacilityPlan[] = [];
  const enabledFacilities = state.facilities;
  const globalBonus = calculateGlobalBonus(state);

  for (const facility of enabledFacilities) {
    const candidates = findCandidates(facility, state, globalBonus)
      .filter((candidate) => !usedOperatorIds.has(candidate.operatorId))
      .sort((a, b) => b.score - a.score);
    const assignments = candidates.slice(0, facility.slotCount);
    assignments.forEach((assignment) => usedOperatorIds.add(assignment.operatorId));

    const expectedEfficiency = assignments.reduce((sum, assignment) => sum + assignment.efficiency, 0);
    facilityPlans.push({
      facility,
      assignments,
      expectedEfficiency,
      score: assignments.reduce((sum, assignment) => sum + assignment.score, 0),
      alternatives: candidates.slice(facility.slotCount, facility.slotCount + 3)
    });
  }

  const activeAssignments = facilityPlans.flatMap((plan) => plan.assignments);
  const restAssignments = activeAssignments
    .filter((assignment) => assignment.fatigueHours > 0)
    .sort((a, b) => a.fatigueHours - b.fatigueHours);
  const totalScore = facilityPlans.reduce((sum, plan) => sum + plan.score, 0);
  const dailyValue = facilityPlans.reduce(
    (sum, plan) => sum + plan.expectedEfficiency * productWeight(plan.facility.product, state.preference) * 24,
    0
  );

  const warnings = buildWarnings(enabledFacilities, facilityPlans);

  return {
    generatedAt: new Date().toISOString(),
    totalScore,
    dailyValue,
    facilityPlans,
    rotation: [
      {
        label: "第1シフト",
        hours: 12,
        assignments: activeAssignments.filter((assignment) => assignment.fatigueHours > 0),
        recovery: []
      },
      {
        label: "第2シフト",
        hours: 12,
        assignments: restAssignments.filter((assignment) => assignment.fatigueHours >= 18),
        recovery: restAssignments.filter((assignment) => assignment.fatigueHours <= 12)
      },
      {
        label: "回復枠",
        hours: recoveryBaseHours,
        assignments: [],
        recovery: restAssignments
      }
    ],
    warnings
  };
}

export function findCandidates(facility: FacilitySlot, state: AppState, globalBonus = 0): Assignment[] {
  return operators
    .flatMap((operator) => {
      const rosterEntry = state.roster[operator.id];
      if (!rosterEntry?.owned) {
        return [];
      }

      return bestSkillForFacility(operator, rosterEntry, facility, state.preference, globalBonus);
    })
    .sort((a, b) => b.score - a.score);
}

function bestSkillForFacility(
  operator: Operator,
  rosterEntry: RosterEntry,
  facility: FacilitySlot,
  preference: OptimizationPreference,
  globalBonus: number
): Assignment[] {
  const assignments: Assignment[] = [];

  for (const skill of operator.skills) {
    if (skill.unlockPhase > rosterEntry.elite) {
      continue;
    }

    for (const effect of skill.effects) {
      if (!effectMatchesFacility(effect, facility)) {
        continue;
      }

      const productMultiplier = productWeight(facility.product, preference);
      const eliteBonus = rosterEntry.elite * 0.015;
      const effectiveEfficiency = effect.efficiency + eliteBonus + globalBonus;
      assignments.push({
        facilityId: facility.id,
        operatorId: operator.id,
        skillId: skill.id,
        score: effectiveEfficiency * productMultiplier * facilityWeight(facility),
        efficiency: effectiveEfficiency,
        fatigueHours: fatigueHoursByFacility[facility.type],
        recoveryHours: facility.type === "dormitory" ? 0 : Math.max(4, recoveryBaseHours - globalBonus * 8),
        reason: `${skill.name}: ${effect.description}`
      });
    }
  }

  return assignments.sort((a, b) => b.score - a.score).slice(0, 1);
}

function effectMatchesFacility(effect: BaseSkillEffect, facility: FacilitySlot): boolean {
  if (effect.facility !== facility.type) {
    return false;
  }

  return !effect.product || effect.product === facility.product || facility.type === "control";
}

function calculateGlobalBonus(state: AppState): number {
  return operators.reduce((sum, operator) => {
    const rosterEntry = state.roster[operator.id];
    if (!rosterEntry?.owned) {
      return sum;
    }

    const activeControlEffects = operator.skills
      .filter((skill: BaseSkill) => skill.unlockPhase <= rosterEntry.elite)
      .flatMap((skill) => skill.effects)
      .filter((effect) => effect.facility === "control" && effect.tags?.some((tag) => tag.startsWith("global-")));

    return sum + activeControlEffects.reduce((effectSum, effect) => effectSum + effect.efficiency * 0.25, 0);
  }, 0);
}

function productWeight(product: ProductType, preference: OptimizationPreference): number {
  if (product === "gold") {
    return preference.gold;
  }
  if (product === "battleRecord") {
    return preference.battleRecord;
  }
  if (product === "lmd") {
    return preference.lmd;
  }
  if (product === "power") {
    return (preference.gold + preference.battleRecord + preference.lmd) / 3;
  }
  return 0.2;
}

function facilityWeight(facility: FacilitySlot): number {
  if (facility.type === "factory" || facility.type === "trading") {
    return 100;
  }
  if (facility.type === "power") {
    return 65;
  }
  if (facility.type === "control") {
    return 55;
  }
  return 35;
}

function buildWarnings(enabledFacilities: FacilitySlot[], facilityPlans: FacilityPlan[]): string[] {
  const warnings: string[] = [];
  const shortPlans = facilityPlans.filter((plan) => plan.assignments.length < plan.facility.slotCount);

  if (shortPlans.length > 0) {
    warnings.push("一部施設でスロット数に対して候補オペレーターが不足しています。所有設定か昇進段階を見直してください。");
  }

  return warnings;
}
