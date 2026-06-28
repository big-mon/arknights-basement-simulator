import { operators } from "../data/defaults";
import { clampEliteForOperator } from "./elite";
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
  roster?: AppState["roster"];
};

type GlobalBonusBucket = {
  stackKey?: string;
  value: number;
};

const fatigueHoursByFacility: Record<FacilitySlot["type"], number> = {
  factory: 12,
  trading: 12,
  power: 18,
  control: 24,
  dormitory: 0,
  reception: 24
};

const recoveryBaseHours = 8;

const maxFacilityLevelByType: Record<FacilitySlot["type"], number> = {
  factory: 3,
  trading: 3,
  power: 3,
  control: 5,
  dormitory: 5,
  reception: 3
};

export function generateAssignmentPlan(state: AppState): AssignmentPlan {
  const enabledFacilities = state.facilities.filter((facility) => facility.type !== "dormitory");
  let facilityPlans = buildFacilityPlans(state, enabledFacilities, []);

  for (let index = 0; index < 3; index += 1) {
    const nextFacilityPlans = buildFacilityPlans(state, enabledFacilities, facilityPlans.flatMap((plan) => plan.assignments));
    if (assignmentSignature(nextFacilityPlans) === assignmentSignature(facilityPlans)) {
      facilityPlans = nextFacilityPlans;
      break;
    }
    facilityPlans = nextFacilityPlans;
  }

  facilityPlans = attachRotationAlternatives(state, facilityPlans);

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
  contextAssignments: Assignment[]
): FacilityPlan[] {
  const usedOperatorIds = new Set<string>();
  const facilityPlans: FacilityPlan[] = [];
  const context: AssignmentEvaluationContext = {
    assignments: contextAssignments,
    facilities: state.facilities,
    roster: state.roster
  };

  for (const facility of enabledFacilities) {
    const globalBonus = calculateGlobalBonus(state, facility, context);
    const candidates = findCandidates(facility, state, globalBonus, context)
      .filter((candidate) => !usedOperatorIds.has(candidate.operatorId))
      .sort((a, b) => b.score - a.score);
    const assignments = candidates.slice(0, facility.slotCount);
    assignments.forEach((assignment) => usedOperatorIds.add(assignment.operatorId));

    const expectedEfficiency = effectiveFacilityEfficiency(assignments);
    facilityPlans.push({
      facility,
      assignments,
      expectedEfficiency,
      score: effectiveFacilityScore(assignments, facility, state.preference),
      alternatives: []
    });
  }

  return facilityPlans;
}

function attachRotationAlternatives(state: AppState, facilityPlans: FacilityPlan[]): FacilityPlan[] {
  const firstRotationOperatorIds = new Set(facilityPlans.flatMap((plan) => plan.assignments.map((assignment) => assignment.operatorId)));
  const secondRotationOperatorIds = new Set<string>();
  const context: AssignmentEvaluationContext = {
    assignments: facilityPlans.flatMap((plan) => plan.assignments),
    facilities: state.facilities,
    roster: state.roster
  };

  return facilityPlans.map((plan) => {
    const globalBonus = calculateGlobalBonus(state, plan.facility, context);
    const alternatives = findCandidates(plan.facility, state, globalBonus, context)
      .filter((candidate) => !firstRotationOperatorIds.has(candidate.operatorId))
      .filter((candidate) => !secondRotationOperatorIds.has(candidate.operatorId))
      .slice(0, plan.facility.slotCount);

    alternatives.forEach((assignment) => secondRotationOperatorIds.add(assignment.operatorId));

    return {
      ...plan,
      alternatives
    };
  });
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
  const evaluationContext = {
    assignments: context?.assignments ?? [],
    facilities: context?.facilities ?? state.facilities,
    roster: context?.roster ?? state.roster
  };

  return operators
    .flatMap((operator) => {
      const rosterEntry = state.roster[operator.id];
      if (!rosterEntry?.owned) {
        return [];
      }

      return bestSkillForFacility(operator, rosterEntry, facility, state.preference, globalBonus, state.language, evaluationContext);
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
  const elite = clampEliteForOperator(operator, rosterEntry.elite);

  for (const skill of operator.skills) {
    if (skill.unlockPhase > elite) {
      continue;
    }

    for (const effect of skill.effects) {
      if (effect.ignoredForOptimization) {
        continue;
      }

      if (!effectMatchesFacility(effect, facility) || !effectConditionsSatisfied(effect, operator, facility, context)) {
        continue;
      }

      const productMultiplier = productWeight(facility.product, preference);
      const eliteBonus = elite * 0.015;
      const scalingMultiplier = effectScalingMultiplier(effect, operator, facility, context);
      const conditionalBonus = effectConditionalBonus(effect, operator, facility, context);
      const effectiveEfficiency =
        (effect.baseEfficiency ?? 0) + effect.efficiency * scalingMultiplier + conditionalBonus + eliteBonus + globalBonus;
      assignments.push({
        facilityId: facility.id,
        operatorId: operator.id,
        skillId: skill.id,
        score: effectiveEfficiency * productMultiplier * facilityWeight(facility),
        efficiency: effectiveEfficiency,
        storageLimit: effect.storageLimit,
        orderLimit: effect.orderLimit,
        ...(effect.suppressesOtherFactoryEfficiency ? { suppressesOtherFactoryEfficiency: true } : {}),
        fatigueHours: fatigueHoursByFacility[facility.type],
        recoveryHours: facility.type === "dormitory" ? 0 : Math.max(4, recoveryBaseHours - globalBonus * 8),
        reason: `${localizeText(skill.name, language)}: ${localizeText(effect.description, language)}`
      });
    }
  }

  return assignments.sort((a, b) => b.score - a.score).slice(0, 1);
}

function effectiveFacilityEfficiency(assignments: Assignment[]) {
  const suppressingAssignments = assignments.filter((assignment) => assignment.suppressesOtherFactoryEfficiency);
  const countedAssignments = suppressingAssignments.length ? suppressingAssignments : assignments;
  return countedAssignments.reduce((sum, assignment) => sum + assignment.efficiency, 0);
}

function effectiveFacilityScore(assignments: Assignment[], facility: FacilitySlot, preference: OptimizationPreference) {
  return effectiveFacilityEfficiency(assignments) * productWeight(facility.product, preference) * facilityWeight(facility);
}

function effectScalingMultiplier(
  effect: BaseSkillEffect,
  operator: Operator,
  facility: FacilitySlot,
  context?: AssignmentEvaluationContext
) {
  if (!effect.scaling) {
    return 1;
  }

  if (effect.scaling.type === "fixed") {
    return effect.scaling.count ?? 0;
  }

  if (effect.scaling.type === "facilityLevel") {
    const level = maxFacilityLevelByType[effect.scaling.facility ?? facility.type];
    return effect.scaling.max ? Math.min(level, effect.scaling.max) : level;
  }

  if (effect.scaling.type === "facilityCount") {
    return facilityCount(effect, context);
  }

  if (effect.scaling.type === "facilityProductCount") {
    return facilityProductCount(effect, context);
  }

  if (effect.scaling.type === "facilityGroupAffiliation") {
    return facilityGroupAffiliationCount(effect, operator, facility, context);
  }

  if (effect.scaling.type === "resource") {
    const resource = effect.scaling.resource ? resourceAmount(effect.scaling.resource, context) : 0;
    const count = effect.scaling.per ? Math.floor(resource / effect.scaling.per) : resource;
    return effect.scaling.max ? Math.min(count, effect.scaling.max) : count;
  }

  if (effect.scaling.type === "facilityStorageLimit") {
    const count = facilityAssignmentStat(effect, operator, facility, context, "storageLimit");
    return effect.scaling.max ? Math.min(count, effect.scaling.max) : count;
  }

  if (effect.scaling.type === "facilityOrderLimit") {
    const count = facilityAssignmentStat(effect, operator, facility, context, "orderLimit");
    const scaled = effect.scaling.per ? Math.floor(count / effect.scaling.per) : count;
    return effect.scaling.max ? Math.min(scaled, effect.scaling.max) : scaled;
  }

  const assignedMatches =
    context?.assignments.filter((assignment) => {
      if (assignment.operatorId === operator.id || !effect.scaling) {
        return false;
      }
      const assignedFacility = context.facilities.find((candidate) => candidate.id === assignment.facilityId);
      const matchesFacility = scalingMatchesFacility(effect.scaling, facility, assignment, assignedFacility);
      return matchesFacility && operatorMatchesScalingAffiliation(assignment.operatorId, effect.scaling);
    }).length ?? 0;
  const selfMatches =
    effect.scaling.includeSelf &&
    scalingCanIncludeSelf(effect.scaling, facility) &&
    operatorMatchesSelfScalingAffiliation(operator, effect.scaling)
      ? 1
      : 0;
  const count = assignedMatches + selfMatches;

  return effect.scaling.max ? Math.min(count, effect.scaling.max) : count;
}

function facilityAssignmentStat(
  effect: BaseSkillEffect,
  operator: Operator,
  facility: FacilitySlot,
  context: AssignmentEvaluationContext | undefined,
  key: "storageLimit" | "orderLimit"
) {
  const assignedTotal =
    context?.assignments
      .filter((assignment) => {
        if (!effect.scaling || assignment.operatorId === operator.id) {
          return false;
        }
        const assignedFacility = context.facilities.find((candidate) => candidate.id === assignment.facilityId);
        return scalingMatchesFacility(effect.scaling, facility, assignment, assignedFacility);
      })
      .reduce((sum, assignment) => sum + (assignment[key] ?? 0), 0) ?? 0;
  const selfTotal = effect.scaling?.includeSelf ? effect[key] ?? 0 : 0;
  return assignedTotal + selfTotal;
}

function facilityCount(effect: BaseSkillEffect, context?: AssignmentEvaluationContext) {
  if (!effect.scaling || !context) {
    return 0;
  }

  const count = context.facilities.filter((facility) => !effect.scaling?.facility || facility.type === effect.scaling.facility).length;
  return effect.scaling.max ? Math.min(count, effect.scaling.max) : count;
}

function facilityProductCount(effect: BaseSkillEffect, context?: AssignmentEvaluationContext) {
  if (!effect.scaling || !context) {
    return 0;
  }

  const count = context.facilities.filter(
    (facility) =>
      (!effect.scaling?.facility || facility.type === effect.scaling.facility) &&
      (!effect.scaling?.product || facility.product === effect.scaling.product)
  ).length;
  return effect.scaling.max ? Math.min(count, effect.scaling.max) : count;
}

function facilityGroupAffiliationCount(
  effect: BaseSkillEffect,
  operator: Operator,
  facility: FacilitySlot,
  context?: AssignmentEvaluationContext
) {
  if (!effect.scaling || !context) {
    return 0;
  }

  const facilityCounts = new Map<string, number>();
  for (const assignment of context.assignments) {
    const assignedFacility = context.facilities.find((candidate) => candidate.id === assignment.facilityId);
    if (!assignedFacility || (effect.scaling.facility && assignedFacility.type !== effect.scaling.facility)) {
      continue;
    }
    if (operatorMatchesScalingAffiliation(assignment.operatorId, effect.scaling)) {
      facilityCounts.set(assignment.facilityId, (facilityCounts.get(assignment.facilityId) ?? 0) + 1);
    }
  }

  if (
    effect.scaling.includeSelf &&
    scalingCanIncludeSelf(effect.scaling, facility) &&
    operatorMatchesSelfScalingAffiliation(operator, effect.scaling)
  ) {
    facilityCounts.set(facility.id, (facilityCounts.get(facility.id) ?? 0) + 1);
  }

  const min = effect.scaling.min ?? 1;
  const count = [...facilityCounts.values()].filter((affiliationCount) => affiliationCount >= min).length;
  return effect.scaling.max ? Math.min(count, effect.scaling.max) : count;
}

function operatorMatchesScalingAffiliation(operatorId: string, scaling: NonNullable<BaseSkillEffect["scaling"]>) {
  if (!scaling.affiliations?.length) {
    return true;
  }
  return operatorHasAnyAffiliation(operatorId, scaling.affiliations);
}

function operatorMatchesSelfScalingAffiliation(operator: Operator, scaling: NonNullable<BaseSkillEffect["scaling"]>) {
  if (!scaling.affiliations?.length) {
    return true;
  }
  return Boolean(operator.affiliations?.some((affiliation) => scaling.affiliations?.includes(affiliation)));
}

function scalingMatchesFacility(
  scaling: NonNullable<BaseSkillEffect["scaling"]>,
  candidateFacility: FacilitySlot,
  assignment: Assignment,
  assignedFacility?: FacilitySlot
) {
  if (scaling.scope === "sameFacility") {
    return assignment.facilityId === candidateFacility.id;
  }
  if (scaling.facility) {
    return assignedFacility?.type === scaling.facility;
  }
  return true;
}

function scalingCanIncludeSelf(scaling: NonNullable<BaseSkillEffect["scaling"]>, facility: FacilitySlot) {
  if (scaling.scope === "sameFacility") {
    return true;
  }
  return !scaling.facility || scaling.facility === facility.type;
}

function effectConditionalBonus(
  effect: BaseSkillEffect,
  operator: Operator,
  facility: FacilitySlot,
  context?: AssignmentEvaluationContext
) {
  return (
    effect.conditionalBonuses?.reduce((sum, bonus) => {
      if (conditionsSatisfied(bonus.conditions, operator, facility, context)) {
        return sum + bonus.efficiency;
      }
      return sum;
    }, 0) ?? 0
  );
}

function resourceAmount(resource: string, context?: AssignmentEvaluationContext) {
  if (!context) {
    return 0;
  }

  return context.assignments.reduce((sum, assignment) => {
    const operator = operators.find((candidate) => candidate.id === assignment.operatorId);
    const facility = context.facilities.find((candidate) => candidate.id === assignment.facilityId);
    if (!operator || !facility) {
      return sum;
    }

    const effects = operator.skills
      .filter((skill: BaseSkill) => skill.unlockPhase <= clampEliteForOperator(operator, context.roster?.[operator.id]?.elite ?? 0))
      .flatMap((skill) => skill.effects)
      .filter((effect) => effect.facility === facility.type && effect.resourceEffects?.some((resourceEffect) => resourceEffect.resource === resource))
      .filter((effect) => effectConditionsSatisfied(effect, operator, facility, context));

    return (
      sum +
      effects.reduce(
        (effectSum, effect) =>
          effectSum +
          (effect.resourceEffects ?? [])
            .filter((resourceEffect) => resourceEffect.resource === resource)
            .reduce(
              (resourceSum, resourceEffect) =>
                resourceSum + resourceEffect.amount * resourceEffectMultiplier(resourceEffect, operator, facility, context),
              0
            ),
        0
      )
    );
  }, 0);
}

function resourceEffectMultiplier(
  resourceEffect: NonNullable<BaseSkillEffect["resourceEffects"]>[number],
  operator: Operator,
  facility: FacilitySlot,
  context: AssignmentEvaluationContext
) {
  if (!resourceEffect.scaling) {
    return 1;
  }
  if (resourceEffect.scaling.type === "fixed") {
    return resourceEffect.scaling.count ?? 0;
  }
  if (resourceEffect.scaling.type === "facilityCount") {
    const count = context.facilities.filter(
      (facility) => !resourceEffect.scaling?.facility || facility.type === resourceEffect.scaling.facility
    ).length;
    return resourceEffect.scaling.max ? Math.min(count, resourceEffect.scaling.max) : count;
  }
  if (resourceEffect.scaling.type === "affiliation") {
    const assignedMatches = context.assignments.filter((assignment) => {
      if (assignment.operatorId === operator.id) {
        return false;
      }
      const assignedFacility = context.facilities.find((candidate) => candidate.id === assignment.facilityId);
      return scalingMatchesFacility(resourceEffect.scaling!, facility, assignment, assignedFacility) &&
        operatorMatchesScalingAffiliation(assignment.operatorId, resourceEffect.scaling!);
    }).length;
    const selfMatches =
      resourceEffect.scaling.includeSelf &&
      scalingCanIncludeSelf(resourceEffect.scaling, facility) &&
      operatorMatchesSelfScalingAffiliation(operator, resourceEffect.scaling)
        ? 1
        : 0;
    const count = assignedMatches + selfMatches;
    return resourceEffect.scaling.max ? Math.min(count, resourceEffect.scaling.max) : count;
  }
  return 1;
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
  return conditionsSatisfied(effect.conditions ?? [], operator, facility, context);
}

function conditionsSatisfied(
  conditions: BaseSkillEffect["conditions"],
  operator: Operator,
  facility: FacilitySlot,
  context?: AssignmentEvaluationContext
): boolean {
  if (!conditions?.length) {
    return true;
  }
  if (!context) {
    return false;
  }

  return conditions.every((condition) => {
    if (condition.type === "sameFacilityOperator") {
      return context.assignments.some(
        (assignment) => assignment.facilityId === facility.id && condition.operatorIds.includes(assignment.operatorId)
      );
    }

    if (condition.type === "facilityOperator" || condition.type === "assignedOperator") {
      return context.assignments.some((assignment) => {
        const assignedFacility = context.facilities.find((candidate) => candidate.id === assignment.facilityId);
        const matchesFacility = condition.type === "assignedOperator" && !condition.facility ? true : assignedFacility?.type === condition.facility;
        return matchesFacility && condition.operatorIds.includes(assignment.operatorId);
      });
    }

    if (condition.type === "facilityCount") {
      const count = context.facilities.filter((candidate) => candidate.type === condition.facility).length;
      return count >= (condition.min ?? 0) && (condition.max === undefined || count <= condition.max);
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

    const count = context.assignments.filter((assignment) => {
        if (assignment.operatorId === operator.id) {
          return false;
        }
        const assignedFacility = context.facilities.find((candidate) => candidate.id === assignment.facilityId);
        const matchesFacility = condition.facility ? assignedFacility?.type === condition.facility : true;
        return matchesFacility && operatorHasAnyAffiliation(assignment.operatorId, condition.affiliations);
      }).length;
    return count >= (condition.min ?? 1) && (condition.max === undefined || count <= condition.max);
  });
}

function operatorHasAnyAffiliation(operatorId: string, affiliations: string[]) {
  const operator = operators.find((candidate) => candidate.id === operatorId);
  return Boolean(operator?.affiliations?.some((affiliation) => affiliations.includes(affiliation)));
}

function calculateGlobalBonus(state: AppState, facility: FacilitySlot, context: AssignmentEvaluationContext): number {
  const buckets: GlobalBonusBucket[] = [];

  for (const assignment of context.assignments) {
    const operator = operators.find((candidate) => candidate.id === assignment.operatorId);
    const assignedFacility = context.facilities.find((candidate) => candidate.id === assignment.facilityId);
    const rosterEntry = operator ? state.roster[operator.id] : undefined;
    if (!operator || !assignedFacility || assignedFacility.type !== "control" || !rosterEntry?.owned) {
      continue;
    }

    const elite = clampEliteForOperator(operator, rosterEntry.elite);
    const activeEffects = operator.skills
      .filter((skill: BaseSkill) => skill.unlockPhase <= elite)
      .flatMap((skill) => skill.effects)
      .filter((effect) => effect.globalEffect && globalEffectMatchesFacility(effect, facility))
      .filter((effect) => effectConditionsSatisfied(effect, operator, assignedFacility, context));

    for (const effect of activeEffects) {
      const scalingMultiplier = effectScalingMultiplier(effect, operator, assignedFacility, context);
      buckets.push({ stackKey: effect.globalEffect?.stackKey, value: (effect.baseEfficiency ?? 0) + effect.efficiency * scalingMultiplier });
    }
  }

  const stackBuckets = new Map<string, number>();
  let unstacked = 0;
  for (const bucket of buckets) {
    if (bucket.stackKey) {
      stackBuckets.set(bucket.stackKey, Math.max(stackBuckets.get(bucket.stackKey) ?? 0, bucket.value));
    } else {
      unstacked += bucket.value;
    }
  }
  return unstacked + [...stackBuckets.values()].reduce((sum, value) => sum + value, 0);
}

function globalEffectMatchesFacility(effect: BaseSkillEffect, facility: FacilitySlot) {
  return (
    effect.globalEffect?.facility === facility.type &&
    (!effect.globalEffect.product || effect.globalEffect.product === facility.product)
  );
}

function productWeight(product: ProductType, preference: OptimizationPreference): number {
  if (product === "gold") {
    return preference.gold;
  }
  if (product === "battleRecord") {
    return preference.battleRecord;
  }
  if (product === "originium") {
    return 0.05;
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
