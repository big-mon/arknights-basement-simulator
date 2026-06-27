import { operators } from "../data/defaults";
import { localizeText } from "./localization";
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

type AssignmentEvaluationContext = {
  assignments: Assignment[];
  facilities: FacilitySlot[];
};

const fatigueHoursByFacility: Record<FacilitySlot["type"], number> = {
  factory: 12,
  trading: 12,
  power: 18,
  control: 24,
  dormitory: 0
};

const recoveryBaseHours = 8;

export function generateAssignmentPlan(state: AppState): AssignmentPlan {
  const enabledFacilities = state.facilities.filter((facility) => facility.type !== "dormitory");
  const globalBonus = calculateGlobalBonus(state);
  let facilityPlans = buildFacilityPlans(state, enabledFacilities, globalBonus, []);

  for (let index = 0; index < 3; index += 1) {
    const nextFacilityPlans = buildFacilityPlans(state, enabledFacilities, globalBonus, facilityPlans.flatMap((plan) => plan.assignments));
    if (assignmentSignature(nextFacilityPlans) === assignmentSignature(facilityPlans)) {
      facilityPlans = nextFacilityPlans;
      break;
    }
    facilityPlans = nextFacilityPlans;
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
    rotation: buildRotationWindows(activeAssignments, restAssignments, state.rotationCount),
    warnings
  };
}

function buildFacilityPlans(
  state: AppState,
  enabledFacilities: FacilitySlot[],
  globalBonus: number,
  contextAssignments: Assignment[]
): FacilityPlan[] {
  const usedOperatorIds = new Set<string>();
  const facilityPlans: FacilityPlan[] = [];
  const context: AssignmentEvaluationContext = {
    assignments: contextAssignments,
    facilities: state.facilities
  };

  for (const facility of enabledFacilities) {
    const candidates = findCandidates(facility, state, globalBonus, context)
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

  return facilityPlans;
}

function assignmentSignature(facilityPlans: FacilityPlan[]) {
  return facilityPlans
    .flatMap((plan) => plan.assignments.map((assignment) => `${assignment.facilityId}:${assignment.operatorId}:${assignment.skillId}`))
    .join("|");
}

function buildRotationWindows(activeAssignments: Assignment[], restAssignments: Assignment[], rotationCount = 2) {
  if (rotationCount === 3) {
    return [
      {
        label: "第1ローテーション",
        hours: 8,
        assignments: activeAssignments.filter((assignment) => assignment.fatigueHours > 0),
        recovery: []
      },
      {
        label: "第2ローテーション",
        hours: 8,
        assignments: restAssignments.filter((assignment) => assignment.fatigueHours >= 12),
        recovery: restAssignments.filter((assignment) => assignment.fatigueHours <= 12)
      },
      {
        label: "第3ローテーション",
        hours: 8,
        assignments: restAssignments.filter((assignment) => assignment.fatigueHours >= 18),
        recovery: restAssignments
      }
    ];
  }

  return [
    {
      label: "1回目ローテーション",
      hours: 12,
      assignments: activeAssignments.filter((assignment) => assignment.fatigueHours > 0),
      recovery: []
    },
    {
      label: "2回目ローテーション",
      hours: 12,
      assignments: restAssignments.filter((assignment) => assignment.fatigueHours >= 18),
      recovery: restAssignments.filter((assignment) => assignment.fatigueHours <= 12)
    }
  ];
}

export function findCandidates(
  facility: FacilitySlot,
  state: AppState,
  globalBonus = 0,
  context?: AssignmentEvaluationContext
): Assignment[] {
  return operators
    .flatMap((operator) => {
      const rosterEntry = state.roster[operator.id];
      if (!rosterEntry?.owned) {
        return [];
      }

      return bestSkillForFacility(operator, rosterEntry, facility, state.preference, globalBonus, state.language, context);
    })
    .sort((a, b) => b.score - a.score);
}

function bestSkillForFacility(
  operator: Operator,
  rosterEntry: RosterEntry,
  facility: FacilitySlot,
  preference: OptimizationPreference,
  globalBonus: number,
  language: AppState["language"],
  context?: AssignmentEvaluationContext
): Assignment[] {
  const assignments: Assignment[] = [];

  for (const skill of operator.skills) {
    if (skill.unlockPhase > rosterEntry.elite) {
      continue;
    }

    for (const effect of skill.effects) {
      if (!effectMatchesFacility(effect, facility) || !effectConditionsSatisfied(effect, operator, facility, context)) {
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
        reason: `${localizeText(skill.name, language)}: ${localizeText(effect.description, language)}`
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

function effectConditionsSatisfied(
  effect: BaseSkillEffect,
  operator: Operator,
  facility: FacilitySlot,
  context?: AssignmentEvaluationContext
): boolean {
  if (!effect.conditions?.length) {
    return true;
  }
  if (!context) {
    return false;
  }

  return effect.conditions.every((condition) => {
    if (condition.type === "sameFacilityOperator") {
      return context.assignments.some(
        (assignment) => assignment.facilityId === facility.id && condition.operatorIds.includes(assignment.operatorId)
      );
    }

    if (condition.type === "facilityOperator") {
      return context.assignments.some((assignment) => {
        const assignedFacility = context.facilities.find((candidate) => candidate.id === assignment.facilityId);
        return assignedFacility?.type === condition.facility && condition.operatorIds.includes(assignment.operatorId);
      });
    }

    if (condition.type === "sameFacilityAffiliation") {
      return (
        context.assignments.filter(
          (assignment) =>
            assignment.facilityId === facility.id &&
            assignment.operatorId !== operator.id &&
            operatorHasAnyAffiliation(assignment.operatorId, condition.affiliations)
        ).length >= (condition.min ?? 1)
      );
    }

    return (
      context.assignments.filter((assignment) => {
        if (assignment.operatorId === operator.id) {
          return false;
        }
        const assignedFacility = context.facilities.find((candidate) => candidate.id === assignment.facilityId);
        const matchesFacility = condition.facility ? assignedFacility?.type === condition.facility : true;
        return matchesFacility && operatorHasAnyAffiliation(assignment.operatorId, condition.affiliations);
      }).length >= (condition.min ?? 1)
    );
  });
}

function operatorHasAnyAffiliation(operatorId: string, affiliations: string[]) {
  const operator = operators.find((candidate) => candidate.id === operatorId);
  return Boolean(operator?.affiliations?.some((affiliation) => affiliations.includes(affiliation)));
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
