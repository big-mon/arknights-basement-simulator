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
    const assignments = selectAssignmentsForFacility(candidates, facility.slotCount);
    assignments.forEach((assignment) => usedOperatorIds.add(assignment.operatorId));

    const expectedEfficiency = effectiveFacilityEfficiency(assignments) + globalBonus;
    facilityPlans.push({
      facility,
      assignments,
      expectedEfficiency,
      score: effectiveFacilityScore(assignments, facility, state.preference, globalBonus),
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
    const alternatives = selectAssignmentsForFacility(
      findCandidates(plan.facility, state, globalBonus, context)
        .filter((candidate) => !firstRotationOperatorIds.has(candidate.operatorId))
        .filter((candidate) => !secondRotationOperatorIds.has(candidate.operatorId)),
      plan.facility.slotCount
    );

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

function selectAssignmentsForFacility(candidates: Assignment[], slotCount: number) {
  const nonSuppressingAssignments = selectNonSuppressingAssignments(candidates, slotCount);
  const suppressingAssignment = candidates.find((assignment) => assignment.suppressesOtherFactoryEfficiency);
  if (!suppressingAssignment) {
    return nonSuppressingAssignments;
  }

  const nonSuppressingScore = nonSuppressingAssignments.reduce((sum, assignment) => sum + assignment.score, 0);
  return suppressingAssignment.score > nonSuppressingScore ? [suppressingAssignment] : nonSuppressingAssignments;
}

function selectNonSuppressingAssignments(candidates: Assignment[], slotCount: number) {
  const assignments: Assignment[] = [];
  const globalStackKeys = new Set<string>();

  for (const candidate of candidates) {
    if (candidate.suppressesOtherFactoryEfficiency) {
      continue;
    }
    if (candidate.globalStackKey && globalStackKeys.has(candidate.globalStackKey)) {
      continue;
    }
    if (candidate.score < 0 && !hasPositiveLimitSynergy(candidate, assignments)) {
      continue;
    }

    assignments.push(candidate);
    if (candidate.globalStackKey) {
      globalStackKeys.add(candidate.globalStackKey);
    }
    if (assignments.length >= slotCount) {
      break;
    }
  }

  for (const candidate of candidates) {
    if (candidate.score >= 0 || candidate.suppressesOtherFactoryEfficiency || assignments.includes(candidate)) {
      continue;
    }
    if (candidate.globalStackKey && globalStackKeys.has(candidate.globalStackKey)) {
      continue;
    }

    const replacement = bestLimitPartnerReplacement(candidate, assignments, slotCount);
    if (!replacement) {
      continue;
    }

    if (replacement.replaceIndex === undefined) {
      assignments.push(candidate);
    } else {
      const replacedAssignment = assignments[replacement.replaceIndex];
      if (replacedAssignment?.globalStackKey) {
        globalStackKeys.delete(replacedAssignment.globalStackKey);
      }
      assignments[replacement.replaceIndex] = candidate;
    }
    if (candidate.globalStackKey) {
      globalStackKeys.add(candidate.globalStackKey);
    }
  }

  return assignments;
}

function hasPositiveLimitSynergy(candidate: Assignment, selectedAssignments: Assignment[]) {
  return selectedAssignments.some(
    (assignment) =>
      ((candidate.storageLimit ?? 0) > 0 && assignment.scalesWithFacilityStat?.includes("storageLimit")) ||
      ((candidate.orderLimit ?? 0) > 0 && assignment.scalesWithFacilityStat?.includes("orderLimit"))
  );
}

function bestLimitPartnerReplacement(
  candidate: Assignment,
  selectedAssignments: Assignment[],
  slotCount: number
): { gain: number; replaceIndex?: number } | undefined {
  if (!hasPositiveLimitSynergy(candidate, selectedAssignments)) {
    return undefined;
  }

  if (selectedAssignments.length < slotCount) {
    const addedScore = limitSynergyScore(candidate, selectedAssignments) + candidate.score;
    return addedScore > 0 ? { gain: addedScore } : undefined;
  }

  return selectedAssignments
    .map((removedAssignment, replaceIndex) => {
      const remainingAssignments = selectedAssignments.filter((_, index) => index !== replaceIndex);
      return {
        replaceIndex,
        gain: limitSynergyScore(candidate, remainingAssignments) + candidate.score - removedAssignment.score
      };
    })
    .filter((replacement) => replacement.gain > 0)
    .sort((a, b) => b.gain - a.gain)[0];
}

function limitSynergyScore(limitPartner: Assignment, selectedAssignments: Assignment[]) {
  return selectedAssignments.reduce((sum, assignment) => {
    return (
      sum +
      (assignment.facilityStatScalings ?? []).reduce((innerSum, scaling) => {
        const addedLimit = scaling.key === "storageLimit" ? limitPartner.storageLimit ?? 0 : limitPartner.orderLimit ?? 0;
        if (addedLimit <= 0) {
          return innerSum;
        }
        return innerSum + statScalingDelta(scaling, addedLimit) * scaling.efficiencyPerStep * scaling.scorePerEfficiency;
      }, 0)
    );
  }, 0);
}

function statScalingDelta(scaling: NonNullable<Assignment["facilityStatScalings"]>[number], addedLimit: number) {
  const before = statScalingStepCount(scaling.current, scaling);
  const after = statScalingStepCount(scaling.current + addedLimit, scaling);
  return Math.max(after - before, 0);
}

function statScalingStepCount(value: number, scaling: NonNullable<Assignment["facilityStatScalings"]>[number]) {
  const scaled = scaling.per ? Math.floor(value / scaling.per) : value;
  return scaling.max ? Math.min(scaled, scaling.max) : scaled;
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
      const rawEfficiency = (effect.baseEfficiency ?? 0) + effect.efficiency * scalingMultiplier + conditionalBonus + eliteBonus;
      const externalGlobalEffect = isExternalGlobalEffect(effect, facility);
      const effectiveEfficiency = externalGlobalEffect ? 0 : rawEfficiency;
      const scoreProductMultiplier = externalGlobalEffect
        ? productWeight(effect.globalEffect?.product ?? facility.product, preference)
        : productMultiplier;
      const scoreFacilityWeight = externalGlobalEffect ? facilityTypeWeight(effect.globalEffect?.facility ?? facility.type) : facilityWeight(facility);
      const scoreFacilityCount = externalGlobalEffect ? matchingGlobalEffectFacilityCount(effect, context) : 1;
      const storageLimit = activeFacilityLimit(operator, elite, facility, context, "storageLimit");
      const orderLimit = activeFacilityLimit(operator, elite, facility, context, "orderLimit");
      const statScalingKeys = statScalingKeysForEffect(effect);
      const facilityStatScalings = facilityStatScalingsForEffect(effect, operator, facility, preference, context);
      const remoteFacilityStatBonuses = activeRemoteFacilityStatBonuses(operator, elite, facility, context);
      assignments.push({
        facilityId: facility.id,
        operatorId: operator.id,
        skillId: skill.id,
        score: (externalGlobalEffect ? rawEfficiency : effectiveEfficiency) * scoreProductMultiplier * scoreFacilityWeight * scoreFacilityCount,
        efficiency: effectiveEfficiency,
        storageLimit,
        orderLimit,
        ...(effect.suppressesOtherFactoryEfficiency ? { suppressesOtherFactoryEfficiency: true } : {}),
        ...(effect.globalEffect?.stackKey ? { globalStackKey: globalEffectStackIdentity(effect) } : {}),
        ...(statScalingKeys.length ? { scalesWithFacilityStat: statScalingKeys } : {}),
        ...(facilityStatScalings.length ? { facilityStatScalings } : {}),
        ...(remoteFacilityStatBonuses.length ? { remoteFacilityStatBonuses } : {}),
        fatigueHours: fatigueHoursByFacility[facility.type],
        recoveryHours: facility.type === "dormitory" ? 0 : Math.max(4, recoveryBaseHours - globalBonus * 8),
        reason: `${localizeText(skill.name, language)}: ${localizeText(effect.description, language)}`
      });
    }
  }

  return assignments.sort((a, b) => b.score - a.score).slice(0, 1);
}

function activeFacilityLimit(
  operator: Operator,
  elite: number,
  facility: FacilitySlot,
  context: AssignmentEvaluationContext | undefined,
  key: "storageLimit" | "orderLimit"
) {
  const activeLimits = operator.skills
    .filter((skill) => skill.unlockPhase <= elite)
    .flatMap((skill) => skill.effects)
    .filter((effect) => !effect.ignoredForOptimization)
    .filter((effect) => effectMatchesFacility(effect, facility) && effectConditionsSatisfied(effect, operator, facility, context))
    .map((effect) => effect[key])
    .filter((value): value is number => typeof value === "number");

  if (!activeLimits.length) {
    return undefined;
  }

  return activeLimits.reduce((selected, value) => (Math.abs(value) > Math.abs(selected) ? value : selected));
}

function activeRemoteFacilityStatBonuses(
  operator: Operator,
  elite: number,
  facility: FacilitySlot,
  context: AssignmentEvaluationContext | undefined
) {
  return operator.skills
    .filter((skill) => skill.unlockPhase <= elite)
    .flatMap((skill) => skill.effects)
    .filter((effect) => !effect.ignoredForOptimization)
    .filter((effect) => effectMatchesFacility(effect, facility) && effectConditionsSatisfied(effect, operator, facility, context))
    .flatMap((effect) => remoteFacilityStatBonusesForEffect(effect));
}

function effectiveFacilityEfficiency(assignments: Assignment[]) {
  const suppressingAssignments = assignments.filter((assignment) => assignment.suppressesOtherFactoryEfficiency);
  const countedAssignments = suppressingAssignments.length ? suppressingAssignments : assignments;
  return countedAssignments.reduce((sum, assignment) => sum + assignment.efficiency, 0);
}

function effectiveFacilityScore(assignments: Assignment[], facility: FacilitySlot, preference: OptimizationPreference, globalBonus = 0) {
  return (effectiveFacilityEfficiency(assignments) + globalBonus) * productWeight(facility.product, preference) * facilityWeight(facility);
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
    const resource = effect.scaling.resource ? resourceAmount(effect.scaling.resource, context, operator, facility) : 0;
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
      .reduce((sum, assignment) => sum + Math.max(assignment[key] ?? 0, 0), 0) ?? 0;
  const remoteTotal =
    context?.assignments.reduce((sum, assignment) => {
      return (
        sum +
        (assignment.remoteFacilityStatBonuses ?? []).reduce(
          (innerSum, bonus) => innerSum + remoteFacilityStatBonusAmount(bonus, key, facility, context),
          0
        )
      );
    }, 0) ?? 0;
  const selfTotal = effect.scaling?.includeSelf ? Math.max(effect[key] ?? 0, 0) : 0;
  return assignedTotal + remoteTotal + selfTotal;
}

function remoteFacilityStatBonusAmount(
  bonus: NonNullable<Assignment["remoteFacilityStatBonuses"]>[number],
  key: "storageLimit" | "orderLimit",
  facility: FacilitySlot,
  context: AssignmentEvaluationContext
) {
  if (bonus.key !== key || bonus.facility !== facility.type) {
    return 0;
  }
  if (!bonus.affiliations?.length && !bonus.operatorIds?.length) {
    return Math.max(bonus.amount, 0);
  }

  const matchingAssignments = context.assignments.filter(
    (assignment) =>
      assignment.facilityId === facility.id &&
      ((bonus.affiliations?.length && operatorHasAnyAffiliation(assignment.operatorId, bonus.affiliations)) ||
        (bonus.operatorIds?.length && bonus.operatorIds.includes(assignment.operatorId)))
  );
  return matchingAssignments.length >= (bonus.min ?? 1) ? matchingAssignments.length * Math.max(bonus.amount, 0) : 0;
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
    if (assignment.operatorId === operator.id) {
      continue;
    }
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

function resourceAmount(resource: string, context?: AssignmentEvaluationContext, candidateOperator?: Operator, candidateFacility?: FacilitySlot) {
  if (!context) {
    return 0;
  }

  const assignedResource = context.assignments.reduce((sum, assignment) => {
    if (candidateOperator && assignment.operatorId === candidateOperator.id) {
      return sum;
    }
    const operator = operators.find((candidate) => candidate.id === assignment.operatorId);
    const facility = context.facilities.find((candidate) => candidate.id === assignment.facilityId);
    if (!operator || !facility) {
      return sum;
    }

    return sum + resourceAmountFromOperator(resource, operator, facility, context);
  }, 0);

  const candidateResource =
    candidateOperator && candidateFacility ? resourceAmountFromOperator(resource, candidateOperator, candidateFacility, context) : 0;

  return assignedResource + candidateResource;
}

function resourceAmountFromOperator(resource: string, operator: Operator, facility: FacilitySlot, context: AssignmentEvaluationContext) {
  const effects = operator.skills
    .filter((skill: BaseSkill) => skill.unlockPhase <= clampEliteForOperator(operator, context.roster?.[operator.id]?.elite ?? 0))
    .flatMap((skill) => skill.effects)
    .filter((effect) => effectMatchesFacility(effect, facility) && effect.resourceEffects?.some((resourceEffect) => resourceEffect.resource === resource))
    .filter((effect) => effectConditionsSatisfied(effect, operator, facility, context));

  return effects.reduce(
    (effectSum, effect) =>
      effectSum +
      (effect.resourceEffects ?? [])
        .filter((resourceEffect) => resourceEffect.resource === resource)
        .reduce(
          (resourceSum, resourceEffect) => resourceSum + resourceEffect.amount * resourceEffectMultiplier(resourceEffect, operator, facility, context),
          0
        ),
    0
  );
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

export function conditionsSatisfied(
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
      const assigned = context.assignments.some(
        (assignment) => assignment.facilityId === facility.id && condition.operatorIds.includes(assignment.operatorId)
      );
      return assigned || hasOwnedSkilllessPrerequisite(condition.operatorIds, context);
    }

    if (condition.type === "facilityOperator" || condition.type === "assignedOperator") {
      const assigned = context.assignments.some((assignment) => {
        const assignedFacility = context.facilities.find((candidate) => candidate.id === assignment.facilityId);
        const matchesFacility = condition.type === "assignedOperator" && !condition.facility ? true : assignedFacility?.type === condition.facility;
        return matchesFacility && condition.operatorIds.includes(assignment.operatorId);
      });
      const ownedPrerequisite = hasOwnedSkilllessPrerequisite(condition.operatorIds, context);
      return assigned || ownedPrerequisite;
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
    const min = condition.min ?? (condition.max === undefined ? 1 : 0);
    return count >= min && (condition.max === undefined || count <= condition.max);
  });
}

function operatorHasAnyAffiliation(operatorId: string, affiliations: string[]) {
  const operator = operators.find((candidate) => candidate.id === operatorId);
  return Boolean(operator?.affiliations?.some((affiliation) => affiliations.includes(affiliation)));
}

function operatorIsSkillless(operatorId: string) {
  return operators.find((candidate) => candidate.id === operatorId)?.skills.length === 0;
}

function hasOwnedSkilllessPrerequisite(operatorIds: string[], context: AssignmentEvaluationContext) {
  return operatorIds.some((operatorId) => context.roster?.[operatorId]?.owned && operatorIsSkillless(operatorId));
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

function isExternalGlobalEffect(effect: BaseSkillEffect, facility: FacilitySlot) {
  return Boolean(effect.globalEffect && effect.globalEffect.facility !== facility.type);
}

function globalEffectStackIdentity(effect: BaseSkillEffect) {
  return `${effect.globalEffect?.facility}:${effect.globalEffect?.product ?? "*"}:${effect.globalEffect?.stackKey}`;
}

function statScalingKeysForEffect(effect: BaseSkillEffect): NonNullable<Assignment["scalesWithFacilityStat"]> {
  if (effect.scaling?.type === "facilityStorageLimit") {
    return ["storageLimit"];
  }
  if (effect.scaling?.type === "facilityOrderLimit") {
    return ["orderLimit"];
  }
  return [];
}

function facilityStatScalingsForEffect(
  effect: BaseSkillEffect,
  operator: Operator,
  facility: FacilitySlot,
  preference: OptimizationPreference,
  context?: AssignmentEvaluationContext
): NonNullable<Assignment["facilityStatScalings"]> {
  if (effect.scaling?.type === "facilityStorageLimit") {
    return [
      {
        key: "storageLimit",
        current: facilityAssignmentStat(effect, operator, facility, context, "storageLimit"),
        efficiencyPerStep: effect.efficiency,
        scorePerEfficiency: productWeight(facility.product, preference) * facilityWeight(facility),
        max: effect.scaling.max
      }
    ];
  }
  if (effect.scaling?.type === "facilityOrderLimit") {
    return [
      {
        key: "orderLimit",
        current: facilityAssignmentStat(effect, operator, facility, context, "orderLimit"),
        efficiencyPerStep: effect.efficiency,
        scorePerEfficiency: productWeight(facility.product, preference) * facilityWeight(facility),
        per: effect.scaling.per,
        max: effect.scaling.max
      }
    ];
  }
  return [];
}

function remoteFacilityStatBonusesForEffect(effect: BaseSkillEffect): NonNullable<Assignment["remoteFacilityStatBonuses"]> {
  const bonuses: NonNullable<Assignment["remoteFacilityStatBonuses"]> = [];
  for (const condition of effect.conditions ?? []) {
    if (effect.storageLimit) {
      const bonus = remoteFacilityStatBonusForCondition(condition, "storageLimit", effect.storageLimit);
      if (bonus) {
        bonuses.push(bonus);
      }
    }
    if (effect.orderLimit) {
      const bonus = remoteFacilityStatBonusForCondition(condition, "orderLimit", effect.orderLimit);
      if (bonus) {
        bonuses.push(bonus);
      }
    }
  }
  return bonuses;
}

function remoteFacilityStatBonusForCondition(
  condition: NonNullable<BaseSkillEffect["conditions"]>[number],
  key: "storageLimit" | "orderLimit",
  amount: number
): NonNullable<Assignment["remoteFacilityStatBonuses"]>[number] | undefined {
  if (condition.type === "facilityAffiliation" && condition.facility) {
    return {
      key,
      facility: condition.facility,
      amount,
      affiliations: condition.affiliations,
      min: condition.min
    };
  }
  if (condition.type === "facilityOperator") {
    return {
      key,
      facility: condition.facility,
      amount,
      operatorIds: condition.operatorIds
    };
  }
  return undefined;
}

function matchingGlobalEffectFacilityCount(effect: BaseSkillEffect, context?: AssignmentEvaluationContext) {
  if (!effect.globalEffect || !context) {
    return 1;
  }
  const count = context.facilities.filter((facility) => facility.type !== "dormitory" && globalEffectMatchesFacility(effect, facility)).length;
  return Math.max(count, 1);
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
  return facilityTypeWeight(facility.type);
}

function facilityTypeWeight(facilityType: FacilitySlot["type"]): number {
  if (facilityType === "factory" || facilityType === "trading") {
    return 100;
  }
  if (facilityType === "power") {
    return 65;
  }
  if (facilityType === "control") {
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
