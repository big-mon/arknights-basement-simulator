import { operators } from "../data/defaults";
import { clampEliteForOperator } from "./elite";
import { localizeText } from "./localization";
import type {
  AppState,
  Assignment,
  AssignmentPlan,
  BaseSkill,
  BaseSkillCondition,
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

type FacilityAffiliationCondition = Extract<BaseSkillCondition, { type: "facilityAffiliation" }>;

type ComplexBaseSkillHandlerInput = {
  operator: Operator;
  skill: BaseSkill;
  effect: BaseSkillEffect;
  elite: number;
  facility: FacilitySlot;
  context?: AssignmentEvaluationContext;
};

type ComplexBaseSkillHandler = {
  scalingMultiplier?: (input: ComplexBaseSkillHandlerInput) => number;
  remoteFacilityStatBonuses?: (
    input: ComplexBaseSkillHandlerInput
  ) => NonNullable<Assignment["remoteFacilityStatBonuses"]>;
  remoteFacilityEfficiencyBonuses?: (
    input: ComplexBaseSkillHandlerInput
  ) => NonNullable<Assignment["remoteFacilityEfficiencyBonuses"]>;
};

const complexBaseSkillHandlers: Record<string, Record<string, ComplexBaseSkillHandler>> = {
  char_4110_delphn: {
    "control_tra_limit&spd[010]": controlFacilityAffiliationRemoteEfficiencyHandler()
  },
  char_1034_jesca2: {
    "control_bd_spd[000]": controlFacilityAffiliationRemoteEfficiencyHandler()
  },
  char_1045_svash2: {
    "control_tra_limit&spd3[000]": controlFacilityGroupAffiliationRemoteEfficiencyHandler()
  },
  char_4208_wintim: {
    "manu_prod_spd&manu[100]": suppressingSelfOnlySameFacilityScalingHandler()
  },
  char_206_gnosis: {
    "control_tra_limit&spd[000]": controlFacilityAffiliationRemoteStatAndEfficiencyHandler()
  },
  char_420_flamtl: {
    "control_mp_psk[000]": controlFacilityAffiliationRemoteEfficiencyHandler()
  }
};

export function registeredComplexBaseSkillHandlerKeys(capability?: keyof ComplexBaseSkillHandler) {
  return Object.entries(complexBaseSkillHandlers).flatMap(([operatorId, handlers]) =>
    Object.entries(handlers)
      .filter(([, handler]) => !capability || Boolean(handler[capability]))
      .map(([skillId]) => `${operatorId}:${skillId}`)
  );
}

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
    const remoteEfficiencyBonus = calculateRemoteFacilityEfficiencyBonus(facility, context);
    const facilityBonus = globalBonus + remoteEfficiencyBonus;
    const candidates = findCandidates(facility, state, 0, context)
      .filter((candidate) => !usedOperatorIds.has(candidate.operatorId))
      .sort((a, b) => b.score - a.score);
    const assignments = selectAssignmentsForFacility(candidates, facility.slotCount);
    assignments.forEach((assignment) => usedOperatorIds.add(assignment.operatorId));

    const expectedEfficiency = effectiveFacilityEfficiency(assignments) + facilityBonus;
    facilityPlans.push({
      facility,
      assignments,
      expectedEfficiency,
      score: effectiveFacilityScore(assignments, facility, state.preference, facilityBonus),
      alternatives: []
    });
  }

  return facilityPlans;
}

export function attachRotationAlternatives(state: AppState, facilityPlans: FacilityPlan[]): FacilityPlan[] {
  const firstRotationOperatorIds = new Set(facilityPlans.flatMap((plan) => plan.assignments.map((assignment) => assignment.operatorId)));
  let plansWithAlternatives = buildAlternativeFacilityPlans(state, facilityPlans, firstRotationOperatorIds, []);

  for (let index = 0; index < 3; index += 1) {
    const previousSignature = alternativeAssignmentSignature(plansWithAlternatives);
    const contextAssignments = plansWithAlternatives.flatMap((plan) => plan.alternatives);
    const nextPlans = buildAlternativeFacilityPlans(state, facilityPlans, firstRotationOperatorIds, contextAssignments);
    plansWithAlternatives = nextPlans;
    if (alternativeAssignmentSignature(nextPlans) === previousSignature) {
      break;
    }
  }

  const alternativeContext: AssignmentEvaluationContext = {
    assignments: plansWithAlternatives.flatMap((plan) => plan.alternatives),
    facilities: state.facilities,
    roster: state.roster
  };

  return plansWithAlternatives.map((plan) => {
    const globalBonus = calculateGlobalBonus(state, plan.facility, alternativeContext);
    const remoteEfficiencyBonus = calculateRemoteFacilityEfficiencyBonus(plan.facility, alternativeContext);
    return {
      ...plan,
      alternativeExpectedEfficiency: effectiveFacilityEfficiency(plan.alternatives) + globalBonus + remoteEfficiencyBonus
    };
  });
}

function buildAlternativeFacilityPlans(
  state: AppState,
  facilityPlans: FacilityPlan[],
  firstRotationOperatorIds: Set<string>,
  contextAssignments: Assignment[]
) {
  const secondRotationOperatorIds = new Set<string>();
  const context: AssignmentEvaluationContext = {
    assignments: contextAssignments,
    facilities: state.facilities,
    roster: state.roster
  };

  return facilityPlans.map((plan) => {
    const alternatives = selectAssignmentsForFacility(
      findCandidates(plan.facility, state, 0, context)
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

function alternativeAssignmentSignature(facilityPlans: FacilityPlan[]) {
  return facilityPlans
    .flatMap((plan) => plan.alternatives.map((assignment) => `${assignment.facilityId}:${assignment.operatorId}:${assignment.skillId}`))
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
    if (assignments.some((assignment) => assignment.operatorId === candidate.operatorId)) {
      continue;
    }
    if (candidate.globalStackKey && globalStackKeys.has(candidate.globalStackKey)) {
      continue;
    }
    if (candidate.score < 0 && limitSynergyScore(candidate, assignments) + candidate.score <= 0) {
      continue;
    }
    const prerequisiteAssignments = skilllessPrerequisiteAssignments(candidate, assignments);
    const basePrerequisiteAssignments = baseSkilllessPrerequisiteAssignments(candidate, assignments);
    if (facilitySlotOccupancy(assignments) + 1 + prerequisiteAssignments.length > slotCount) {
      continue;
    }

    assignments.push(candidate);
    assignments.push(...prerequisiteAssignments);
    assignments.push(...basePrerequisiteAssignments);
    if (candidate.globalStackKey) {
      globalStackKeys.add(candidate.globalStackKey);
    }
    if (facilitySlotOccupancy(assignments) >= slotCount) {
      break;
    }
  }

  for (const candidate of candidates) {
    if (candidate.suppressesOtherFactoryEfficiency || assignments.includes(candidate)) {
      continue;
    }
    if (assignments.some((assignment) => assignment.operatorId === candidate.operatorId)) {
      continue;
    }
    if (candidate.globalStackKey && globalStackKeys.has(candidate.globalStackKey)) {
      continue;
    }
    const prerequisiteAssignments = skilllessPrerequisiteAssignments(candidate, assignments);
    if (prerequisiteAssignments.length > 0) {
      continue;
    }
    const basePrerequisiteAssignments = baseSkilllessPrerequisiteAssignments(candidate, assignments);

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
    assignments.push(...basePrerequisiteAssignments);
    if (candidate.globalStackKey) {
      globalStackKeys.add(candidate.globalStackKey);
    }
  }

  return assignments;
}

function facilitySlotOccupancy(assignments: Assignment[]) {
  return assignments.filter((assignment) => assignmentConsumesFacilitySlot(assignment)).length;
}

function assignmentConsumesFacilitySlot(assignment: Assignment) {
  return !assignment.doesNotConsumeFacilitySlot;
}

function skilllessPrerequisiteAssignments(candidate: Assignment, selectedAssignments: Assignment[]) {
  return (candidate.skilllessPrerequisiteOperatorIds ?? [])
    .filter((operatorId) => !selectedAssignments.some((assignment) => assignment.operatorId === operatorId))
    .map((operatorId) => ({
      facilityId: candidate.facilityId,
      operatorId,
      skillId: "skillless-prerequisite",
      score: 0,
      efficiency: 0,
      fatigueHours: candidate.fatigueHours,
      recoveryHours: candidate.recoveryHours,
      skilllessPrerequisiteFor: candidate.operatorId,
      reason: "Skillless prerequisite"
    }));
}

function baseSkilllessPrerequisiteAssignments(candidate: Assignment, selectedAssignments: Assignment[]) {
  return (candidate.baseSkilllessPrerequisiteOperatorIds ?? [])
    .filter((operatorId) => !selectedAssignments.some((assignment) => assignment.operatorId === operatorId))
    .map((operatorId) => ({
      facilityId: "base",
      operatorId,
      skillId: "base-skillless-prerequisite",
      score: 0,
      efficiency: 0,
      fatigueHours: candidate.fatigueHours,
      recoveryHours: candidate.recoveryHours,
      baseSkilllessPrerequisiteFor: candidate.operatorId,
      doesNotConsumeFacilitySlot: true,
      reason: "Base-wide skillless prerequisite"
    }));
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

  if (facilitySlotOccupancy(selectedAssignments) < slotCount) {
    const addedScore = limitSynergyScore(candidate, selectedAssignments) + candidate.score;
    return addedScore > 0 ? { gain: addedScore } : undefined;
  }

  return selectedAssignments
    .map((removedAssignment, replaceIndex) => {
      const remainingAssignments = selectedAssignments.filter((_, index) => index !== replaceIndex);
      return {
        consumesFacilitySlot: assignmentConsumesFacilitySlot(removedAssignment),
        locked: assignmentIsSkilllessPrerequisiteLocked(removedAssignment, selectedAssignments),
        replaceIndex,
        gain: limitSynergyScore(candidate, remainingAssignments) + candidate.score - removedAssignment.score
      };
    })
    .filter((replacement) => replacement.consumesFacilitySlot && !replacement.locked && replacement.gain > 0)
    .sort((a, b) => b.gain - a.gain)[0];
}

function assignmentIsSkilllessPrerequisiteLocked(assignment: Assignment, selectedAssignments: Assignment[]) {
  return Boolean(
    assignment.skilllessPrerequisiteFor ||
      assignment.baseSkilllessPrerequisiteFor ||
      selectedAssignments.some(
        (selectedAssignment) =>
          selectedAssignment.skilllessPrerequisiteFor === assignment.operatorId ||
          selectedAssignment.baseSkilllessPrerequisiteFor === assignment.operatorId
      )
  );
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

      const remoteFacilityStatBonuses = activeRemoteFacilityStatBonuses(operator, elite, facility, context);
      const remoteFacilityEfficiencyBonuses = activeRemoteFacilityEfficiencyBonuses(operator, elite, facility, context);
      const remoteFacilityCountBonuses = activeRemoteFacilityCountBonuses(operator, elite, facility, context);
      const productMultiplier = productWeight(facility.product, preference);
      const eliteBonus = elite * 0.015;
      const complexHandler = getComplexBaseSkillHandler(operator, skill);
      const handlerInput = { operator, skill, effect, elite, facility, context };
      const scalingMultiplier = complexHandler?.scalingMultiplier?.(handlerInput) ?? effectScalingMultiplier(effect, operator, elite, facility, context);
      const conditionalBonus = effectConditionalBonus(effect, operator, facility, context);
      const globalEffectEfficiency = (effect.baseEfficiency ?? 0) + effect.efficiency * scalingMultiplier;
      const rawEfficiency = (effect.baseEfficiency ?? 0) + effect.efficiency * scalingMultiplier + conditionalBonus + eliteBonus;
      const externalGlobalEffect = isExternalGlobalEffect(effect, facility);
      const remoteFacilityEfficiencyEffect = facility.type === "control" && remoteFacilityEfficiencyBonuses.length > 0;
      const remoteFacilityStatEffect = facility.type === "control" && remoteFacilityStatBonuses.length > 0;
      const remoteFacilityCountEffect = facility.type === "control" && remoteFacilityCountBonuses.length > 0;
      const effectiveEfficiency = externalGlobalEffect || remoteFacilityEfficiencyEffect || remoteFacilityStatEffect || remoteFacilityCountEffect ? 0 : rawEfficiency;
      const remoteStatScore = remoteFacilityStatScore(remoteFacilityStatBonuses, operator.id, preference, context);
      const remoteEfficiencyScore = remoteFacilityEfficiencyScore(remoteFacilityEfficiencyBonuses, preference, context);
      const remoteCountScore = remoteFacilityCountScore(remoteFacilityCountBonuses, operator.id, preference, context);
      const globalEffectScoreMultiplier = externalGlobalEffect ? globalEffectTargetScoreMultiplier(effect, preference, context) : 0;
      if (externalGlobalEffect && globalEffectScoreMultiplier === 0) {
        continue;
      }
      const storageLimit = activeFacilityLimit(operator, elite, facility, context, "storageLimit");
      const orderLimit = activeFacilityLimit(operator, elite, facility, context, "orderLimit");
      const statScalingKeys = statScalingKeysForEffect(effect);
      const facilityStatScalings = facilityStatScalingsForEffect(effect, operator, elite, facility, preference, context);
      const mandatorySkilllessPrerequisiteOperatorIds = skilllessPrerequisiteOperatorIdsForConditions(effect.conditions ?? [], facility, context);
      const mandatoryBaseSkilllessPrerequisiteOperatorIds = baseSkilllessPrerequisiteOperatorIdsForConditions(effect.conditions ?? [], context);
      const optionalSkilllessConditionalBonuses = skilllessConditionalBonusesForEffect(effect, operator, facility, context);
      const pushAssignment = (
        extraConditionalBonus: number,
        extraSkilllessPrerequisiteOperatorIds: string[],
        extraBaseSkilllessPrerequisiteOperatorIds: string[]
      ) => {
        const variantRawEfficiency = rawEfficiency + extraConditionalBonus;
        const variantEffectiveEfficiency =
          externalGlobalEffect || remoteFacilityEfficiencyEffect || remoteFacilityStatEffect || remoteFacilityCountEffect ? 0 : variantRawEfficiency;
        const skilllessPrerequisiteOperatorIds = Array.from(
          new Set([...mandatorySkilllessPrerequisiteOperatorIds, ...extraSkilllessPrerequisiteOperatorIds])
        );
        const baseSkilllessPrerequisiteOperatorIds = Array.from(
          new Set([...mandatoryBaseSkilllessPrerequisiteOperatorIds, ...extraBaseSkilllessPrerequisiteOperatorIds])
        );
        assignments.push({
          facilityId: facility.id,
          operatorId: operator.id,
          skillId: skill.id,
          score:
            (remoteFacilityEfficiencyEffect
              ? 0
              : externalGlobalEffect
                ? globalEffectEfficiency * globalEffectScoreMultiplier
                : variantEffectiveEfficiency * productMultiplier * facilityWeight(facility)) +
            remoteStatScore +
            remoteEfficiencyScore +
            remoteCountScore,
          efficiency: variantEffectiveEfficiency,
          storageLimit,
          orderLimit,
          ...(effect.suppressesOtherFactoryEfficiency ? { suppressesOtherFactoryEfficiency: true } : {}),
          ...(effect.globalEffect?.stackKey ? { globalStackKey: globalEffectStackIdentity(effect) } : {}),
          ...(skilllessPrerequisiteOperatorIds.length ? { skilllessPrerequisiteOperatorIds } : {}),
          ...(baseSkilllessPrerequisiteOperatorIds.length ? { baseSkilllessPrerequisiteOperatorIds } : {}),
          ...(statScalingKeys.length ? { scalesWithFacilityStat: statScalingKeys } : {}),
          ...(facilityStatScalings.length ? { facilityStatScalings } : {}),
          ...(remoteFacilityStatBonuses.length ? { remoteFacilityStatBonuses } : {}),
          ...(remoteFacilityEfficiencyBonuses.length ? { remoteFacilityEfficiencyBonuses } : {}),
          ...(remoteFacilityCountBonuses.length ? { remoteFacilityCountBonuses } : {}),
          fatigueHours: fatigueHoursByFacility[facility.type],
          recoveryHours: facility.type === "dormitory" ? 0 : Math.max(4, recoveryBaseHours - globalBonus * 8),
          reason: `${localizeText(skill.name, language)}: ${localizeText(effect.description, language)}`
        });
      };
      pushAssignment(0, [], []);
      if (optionalSkilllessConditionalBonuses.length) {
        pushAssignment(
          optionalSkilllessConditionalBonuses.reduce((sum, bonus) => sum + bonus.efficiency, 0),
          optionalSkilllessConditionalBonuses.flatMap((bonus) => bonus.operatorIds),
          optionalSkilllessConditionalBonuses.flatMap((bonus) => bonus.baseOperatorIds)
        );
      }
    }
  }

  const sortedAssignments = assignments.sort((a, b) => b.score - a.score);
  const bestAssignment = sortedAssignments[0];
  const bestAssignmentWithoutPrerequisites = sortedAssignments.find(
    (assignment) => !assignment.skilllessPrerequisiteOperatorIds?.length && !assignment.baseSkilllessPrerequisiteOperatorIds?.length
  );
  if (
    (bestAssignment?.skilllessPrerequisiteOperatorIds?.length || bestAssignment?.baseSkilllessPrerequisiteOperatorIds?.length) &&
    bestAssignmentWithoutPrerequisites &&
    bestAssignmentWithoutPrerequisites !== bestAssignment
  ) {
    return [bestAssignment, bestAssignmentWithoutPrerequisites];
  }
  return bestAssignment ? [bestAssignment] : [];
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
  const bonuses = operator.skills
    .filter((skill) => skill.unlockPhase <= elite)
    .flatMap((skill) => skill.effects.map((effect) => ({ skill, effect })))
    .filter(({ effect }) => !effect.ignoredForOptimization)
    .filter(({ effect }) => effectMatchesFacility(effect, facility) && effectConditionsSatisfied(effect, operator, facility, context))
    .flatMap(({ skill, effect }) => remoteFacilityStatBonusesForEffect(operator, skill, effect, elite, facility, context));

  return strongestRemoteFacilityStatBonuses(bonuses);
}

function strongestRemoteFacilityStatBonuses(
  bonuses: NonNullable<Assignment["remoteFacilityStatBonuses"]>
): NonNullable<Assignment["remoteFacilityStatBonuses"]> {
  const selectedBonuses = new Map<string, NonNullable<Assignment["remoteFacilityStatBonuses"]>[number]>();
  for (const bonus of bonuses) {
    const key = remoteFacilityStatBonusIdentity(bonus);
    const selected = selectedBonuses.get(key);
    if (!selected || Math.abs(bonus.amount) > Math.abs(selected.amount)) {
      selectedBonuses.set(key, bonus);
    }
  }
  return [...selectedBonuses.values()];
}

function remoteFacilityStatBonusIdentity(bonus: NonNullable<Assignment["remoteFacilityStatBonuses"]>[number]) {
  return [
    bonus.key,
    bonus.facility,
    bonus.min ?? "",
    [...(bonus.affiliations ?? [])].sort().join(","),
    [...(bonus.operatorIds ?? [])].sort().join(",")
  ].join("|");
}

function activeRemoteFacilityEfficiencyBonuses(
  operator: Operator,
  elite: number,
  facility: FacilitySlot,
  context: AssignmentEvaluationContext | undefined
) {
  return operator.skills
    .filter((skill) => skill.unlockPhase <= elite)
    .flatMap((skill) => skill.effects.map((effect) => ({ skill, effect })))
    .filter(({ effect }) => !effect.ignoredForOptimization)
    .filter(({ effect }) => effectMatchesFacility(effect, facility) && effectConditionsSatisfied(effect, operator, facility, context))
    .flatMap(({ skill, effect }) => remoteFacilityEfficiencyBonusesForEffect(operator, skill, effect, elite, facility, context));
}

function activeRemoteFacilityCountBonuses(
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
    .flatMap((effect) => effect.facilityCountBonuses ?? []);
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
  elite: number,
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

  if (effect.scaling?.type === "facilityGroupAffiliation") {
    return facilityGroupAffiliationCount(effect, operator, facility, context);
  }

  if (effect.scaling.type === "resource") {
    const resource = effect.scaling.resource ? resourceAmount(effect.scaling.resource, context, operator, facility) : 0;
    const count = effect.scaling.per ? Math.floor(resource / effect.scaling.per) : resource;
    return effect.scaling.max ? Math.min(count, effect.scaling.max) : count;
  }

  if (effect.scaling.type === "facilityStorageLimit") {
    const count = facilityAssignmentStat(effect, operator, elite, facility, context, "storageLimit");
    return effect.scaling.max ? Math.min(count, effect.scaling.max) : count;
  }

  if (effect.scaling.type === "facilityOrderLimit") {
    const count = facilityAssignmentStat(effect, operator, elite, facility, context, "orderLimit");
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
  elite: number,
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
  const selfTotal = effect.scaling?.includeSelf ? Math.max(activeFacilityLimit(operator, elite, facility, context, key) ?? 0, 0) : 0;
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

function calculateRemoteFacilityEfficiencyBonus(facility: FacilitySlot, context: AssignmentEvaluationContext): number {
  return context.assignments.reduce((sum, assignment) => {
    return (
      sum +
      (assignment.remoteFacilityEfficiencyBonuses ?? []).reduce(
        (innerSum, bonus) => innerSum + remoteFacilityEfficiencyBonusAmount(bonus, facility, context),
        0
      )
    );
  }, 0);
}

function remoteFacilityEfficiencyBonusAmount(
  bonus: NonNullable<Assignment["remoteFacilityEfficiencyBonuses"]>[number],
  facility: FacilitySlot,
  context: AssignmentEvaluationContext
) {
  if (bonus.facility !== facility.type || (bonus.product && bonus.product !== facility.product)) {
    return 0;
  }
  if (bonus.groupAffiliations?.length) {
    const matchingAssignments = context.assignments.filter(
      (assignment) => assignment.facilityId === facility.id && operatorHasAnyAffiliation(assignment.operatorId, bonus.groupAffiliations ?? [])
    );
    return matchingAssignments.length >= (bonus.min ?? 1) ? bonus.amount : 0;
  }
  if (!bonus.affiliations?.length && !bonus.operatorIds?.length) {
    return bonus.amount;
  }

  const matchingAssignments = context.assignments.filter(
    (assignment) =>
      assignment.facilityId === facility.id &&
      ((bonus.affiliations?.length && operatorHasAnyAffiliation(assignment.operatorId, bonus.affiliations)) ||
        (bonus.operatorIds?.length && bonus.operatorIds.includes(assignment.operatorId)))
  );
  return matchingAssignments.length >= (bonus.min ?? 1) ? matchingAssignments.length * bonus.amount : 0;
}

function facilityCount(effect: BaseSkillEffect, context?: AssignmentEvaluationContext) {
  if (!effect.scaling || !context) {
    return 0;
  }

  const physicalCount = context.facilities.filter((facility) => !effect.scaling?.facility || facility.type === effect.scaling.facility).length;
  const virtualCount = context.assignments.reduce(
    (sum, assignment) =>
      sum +
      (assignment.remoteFacilityCountBonuses ?? [])
        .filter((bonus) => !effect.scaling?.facility || bonus.facility === effect.scaling.facility)
        .reduce((bonusSum, bonus) => bonusSum + bonus.amount, 0),
    0
  );
  const count = physicalCount + virtualCount;
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
      if (
        conditionsSatisfied(bonus.conditions, operator, facility, context, {
          allowOwnedSkilllessPrerequisites: false,
          allowBaseSkilllessPrerequisiteAssignments: false
        })
      ) {
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
  context?: AssignmentEvaluationContext,
  options: { allowOwnedSkilllessPrerequisites?: boolean; allowBaseSkilllessPrerequisiteAssignments?: boolean } = {}
): boolean {
  if (!conditions?.length) {
    return true;
  }
  if (!context) {
    return false;
  }
  const allowOwnedSkilllessPrerequisites = options.allowOwnedSkilllessPrerequisites ?? true;
  const allowBaseSkilllessPrerequisiteAssignments = options.allowBaseSkilllessPrerequisiteAssignments ?? true;

  return conditions.every((condition) => {
    if (condition.type === "sameFacilityOperator") {
      const assigned = context.assignments.some(
        (assignment) => assignment.facilityId === facility.id && condition.operatorIds.includes(assignment.operatorId)
      );
      return assigned || (allowOwnedSkilllessPrerequisites && hasOwnedSkilllessPrerequisite(condition.operatorIds, context));
    }

    if (condition.type === "facilityOperator" || condition.type === "assignedOperator") {
      const assigned = context.assignments.some((assignment) => {
        const assignedFacility = context.facilities.find((candidate) => candidate.id === assignment.facilityId);
        if (
          condition.type === "assignedOperator" &&
          !condition.facility &&
          assignment.baseSkilllessPrerequisiteFor &&
          !allowBaseSkilllessPrerequisiteAssignments
        ) {
          return false;
        }
        const matchesFacility = condition.type === "assignedOperator" && !condition.facility ? true : assignedFacility?.type === condition.facility;
        return matchesFacility && condition.operatorIds.includes(assignment.operatorId);
      });
      if (condition.type === "assignedOperator" && condition.facility) {
        return assigned;
      }
      if (condition.type === "assignedOperator") {
        return assigned;
      }
      const ownedPrerequisite = allowOwnedSkilllessPrerequisites && hasOwnedSkilllessPrerequisite(condition.operatorIds, context);
      return assigned || (condition.facility === facility.type ? ownedPrerequisite : false);
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

function skilllessPrerequisiteOperatorIdsForConditions(
  conditions: NonNullable<BaseSkillEffect["conditions"]>,
  facility: FacilitySlot,
  context?: AssignmentEvaluationContext
) {
  if (!context) {
    return [];
  }
  const operatorIds = conditions.flatMap((condition) => {
    if (
      condition.type === "sameFacilityOperator" ||
      (condition.type === "facilityOperator" && condition.facility === facility.type)
    ) {
      const operatorId = condition.operatorIds.find((candidateId) => context.roster?.[candidateId]?.owned && operatorIsSkillless(candidateId));
      return operatorId ? [operatorId] : [];
    }
    return [];
  });
  return Array.from(new Set(operatorIds));
}

function baseSkilllessPrerequisiteOperatorIdsForConditions(
  conditions: NonNullable<BaseSkillEffect["conditions"]>,
  context?: AssignmentEvaluationContext
) {
  if (!context) {
    return [];
  }
  const operatorIds = conditions.flatMap((condition) => {
    if (condition.type === "assignedOperator" && !condition.facility) {
      const operatorId = condition.operatorIds.find((candidateId) => context.roster?.[candidateId]?.owned && operatorIsSkillless(candidateId));
      return operatorId ? [operatorId] : [];
    }
    return [];
  });
  return Array.from(new Set(operatorIds));
}

function skilllessConditionalBonusesForEffect(
  effect: BaseSkillEffect,
  operator: Operator,
  facility: FacilitySlot,
  context?: AssignmentEvaluationContext
) {
  if (!context) {
    return [];
  }

  return (effect.conditionalBonuses ?? [])
    .map((bonus) => {
      const operatorIds = bonus.conditions.flatMap((condition) => {
        if (
          condition.type === "sameFacilityOperator" ||
          (condition.type === "facilityOperator" && condition.facility === facility.type)
        ) {
          const operatorId = condition.operatorIds.find((candidateId) => context.roster?.[candidateId]?.owned && operatorIsSkillless(candidateId));
          return operatorId ? [operatorId] : [];
        }
        return [];
      });
      const baseOperatorIds = bonus.conditions.flatMap((condition) => {
        if (condition.type === "assignedOperator" && !condition.facility) {
          const operatorId = condition.operatorIds.find((candidateId) => context.roster?.[candidateId]?.owned && operatorIsSkillless(candidateId));
          return operatorId ? [operatorId] : [];
        }
        return [];
      });
      const remainingConditions = bonus.conditions.filter(
        (condition) =>
          !(
            (condition.type === "sameFacilityOperator" || (condition.type === "facilityOperator" && condition.facility === facility.type)) &&
            condition.operatorIds.some((candidateId) => context.roster?.[candidateId]?.owned && operatorIsSkillless(candidateId))
          ) &&
          !(
            condition.type === "assignedOperator" &&
            !condition.facility &&
            condition.operatorIds.some((candidateId) => context.roster?.[candidateId]?.owned && operatorIsSkillless(candidateId))
          )
      );
      return {
        efficiency: bonus.efficiency,
        operatorIds: Array.from(new Set(operatorIds)),
        baseOperatorIds: Array.from(new Set(baseOperatorIds)),
        alreadySatisfied: conditionsSatisfied(bonus.conditions, operator, facility, context, {
          allowOwnedSkilllessPrerequisites: false,
          allowBaseSkilllessPrerequisiteAssignments: false
        }),
        otherConditionsSatisfied: conditionsSatisfied(remainingConditions, operator, facility, context, { allowOwnedSkilllessPrerequisites: false })
      };
    })
    .filter((bonus) => (bonus.operatorIds.length > 0 || bonus.baseOperatorIds.length > 0) && !bonus.alreadySatisfied && bonus.otherConditionsSatisfied);
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
      const scalingMultiplier = effectScalingMultiplier(effect, operator, elite, assignedFacility, context);
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
  elite: number,
  facility: FacilitySlot,
  preference: OptimizationPreference,
  context?: AssignmentEvaluationContext
): NonNullable<Assignment["facilityStatScalings"]> {
  if (effect.scaling?.type === "facilityStorageLimit") {
    return [
      {
        key: "storageLimit",
        current: facilityAssignmentStat(effect, operator, elite, facility, context, "storageLimit"),
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
        current: facilityAssignmentStat(effect, operator, elite, facility, context, "orderLimit"),
        efficiencyPerStep: effect.efficiency,
        scorePerEfficiency: productWeight(facility.product, preference) * facilityWeight(facility),
        per: effect.scaling.per,
        max: effect.scaling.max
      }
    ];
  }
  return [];
}

function getComplexBaseSkillHandler(operator: Operator, skill: BaseSkill) {
  return complexBaseSkillHandlers[operator.id]?.[skill.id];
}

function controlFacilityAffiliationRemoteEfficiencyHandler(): ComplexBaseSkillHandler {
  return {
    remoteFacilityEfficiencyBonuses: ({ effect }) => controlFacilityAffiliationRemoteEfficiencyBonuses(effect)
  };
}

function controlFacilityGroupAffiliationRemoteEfficiencyHandler(): ComplexBaseSkillHandler {
  return {
    remoteFacilityEfficiencyBonuses: ({ effect }) => controlFacilityGroupAffiliationRemoteEfficiencyBonuses(effect)
  };
}

function controlFacilityAffiliationRemoteStatAndEfficiencyHandler(): ComplexBaseSkillHandler {
  return {
    remoteFacilityStatBonuses: ({ effect }) => genericRemoteFacilityStatBonusesForEffect(effect),
    remoteFacilityEfficiencyBonuses: ({ effect }) => controlFacilityAffiliationRemoteEfficiencyBonuses(effect)
  };
}

function suppressingSelfOnlySameFacilityScalingHandler(): ComplexBaseSkillHandler {
  return {
    scalingMultiplier: ({ operator, effect, facility }) => {
      if (!effect.scaling?.includeSelf || !scalingCanIncludeSelf(effect.scaling, facility)) {
        return 0;
      }
      const count = operatorMatchesSelfScalingAffiliation(operator, effect.scaling) ? 1 : 0;
      return effect.scaling.max ? Math.min(count, effect.scaling.max) : count;
    }
  };
}

function remoteFacilityStatBonusesForEffect(
  operator: Operator,
  skill: BaseSkill,
  effect: BaseSkillEffect,
  elite: number,
  facility: FacilitySlot,
  context: AssignmentEvaluationContext | undefined
): NonNullable<Assignment["remoteFacilityStatBonuses"]> {
  const handler = getComplexBaseSkillHandler(operator, skill);
  return handler?.remoteFacilityStatBonuses?.({ operator, skill, effect, elite, facility, context }) ?? genericRemoteFacilityStatBonusesForEffect(effect);
}

function genericRemoteFacilityStatBonusesForEffect(effect: BaseSkillEffect): NonNullable<Assignment["remoteFacilityStatBonuses"]> {
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

function remoteFacilityEfficiencyBonusesForEffect(
  operator: Operator,
  skill: BaseSkill,
  effect: BaseSkillEffect,
  elite: number,
  facility: FacilitySlot,
  context: AssignmentEvaluationContext | undefined
): NonNullable<Assignment["remoteFacilityEfficiencyBonuses"]> {
  const handler = getComplexBaseSkillHandler(operator, skill);
  return handler?.remoteFacilityEfficiencyBonuses?.({ operator, skill, effect, elite, facility, context }) ?? genericRemoteFacilityEfficiencyBonusesForEffect(effect);
}

function genericRemoteFacilityEfficiencyBonusesForEffect(effect: BaseSkillEffect): NonNullable<Assignment["remoteFacilityEfficiencyBonuses"]> {
  if (effect.facility !== "control" || effect.globalEffect) {
    return [];
  }

  if (effect.scaling?.type === "facilityGroupAffiliation") {
    return controlFacilityGroupAffiliationRemoteEfficiencyBonuses(effect);
  }

  if (effect.scaling && effect.scaling.type !== "affiliation") {
    return [];
  }

  return controlFacilityAffiliationRemoteEfficiencyBonuses(effect);
}

function controlFacilityGroupAffiliationRemoteEfficiencyBonuses(
  effect: BaseSkillEffect
): NonNullable<Assignment["remoteFacilityEfficiencyBonuses"]> {
  if (effect.facility !== "control" || effect.globalEffect || effect.scaling?.type !== "facilityGroupAffiliation") {
    return [];
  }
  if (!effect.scaling.facility || effect.scaling.facility === effect.facility) {
    return [];
  }
  return [
    {
      facility: effect.scaling.facility,
      amount: effect.efficiency,
      ...(effect.product && effect.product !== "morale" ? { product: effect.product } : {}),
      groupAffiliations: effect.scaling.affiliations,
      min: effect.scaling.min
    }
  ];
}

function controlFacilityAffiliationRemoteEfficiencyBonuses(
  effect: BaseSkillEffect
): NonNullable<Assignment["remoteFacilityEfficiencyBonuses"]> {
  if (effect.facility !== "control" || effect.globalEffect) {
    return [];
  }
  if (effect.scaling && effect.scaling.type !== "affiliation") {
    return [];
  }

  const matchingCondition = (effect.conditions ?? [])
    .filter((condition): condition is FacilityAffiliationCondition => condition.type === "facilityAffiliation")
    .find(
      (condition) =>
        condition.facility &&
        condition.facility !== effect.facility &&
        (!effect.scaling?.facility || condition.facility === effect.scaling.facility) &&
        condition.affiliations.some((affiliation) => !effect.scaling?.affiliations?.length || effect.scaling.affiliations.includes(affiliation))
    );
  const targetFacility = effect.scaling?.facility ?? matchingCondition?.facility;
  const targetAffiliations = effect.scaling?.affiliations ?? matchingCondition?.affiliations;
  if (!targetFacility || targetFacility === effect.facility || !targetAffiliations?.length) {
    return [];
  }

  return [
    {
      facility: targetFacility,
      amount: effect.efficiency,
      ...(effect.product && effect.product !== "morale" ? { product: effect.product } : {}),
      affiliations: targetAffiliations,
      ...(matchingCondition && "min" in matchingCondition ? { min: matchingCondition.min } : {})
    }
  ];
}

function remoteFacilityStatScore(
  bonuses: NonNullable<Assignment["remoteFacilityStatBonuses"]>,
  sourceOperatorId: string,
  preference: OptimizationPreference,
  context?: AssignmentEvaluationContext
) {
  if (!context) {
    return 0;
  }

  return bonuses.reduce((sum, bonus) => {
    const beneficiaryScore = operators.reduce((operatorSum, operator) => {
      if (operator.id === sourceOperatorId) {
        return operatorSum;
      }
      const rosterEntry = context.roster?.[operator.id];
      if (!rosterEntry?.owned) {
        return operatorSum;
      }
      const elite = clampEliteForOperator(operator, rosterEntry.elite);
      const bestAssignmentScore = context.facilities
        .filter((facility) => facility.type !== "dormitory" && facility.type === bonus.facility)
        .reduce((facilityBest, facility) => {
          const addedLimit = remoteFacilityStatBonusAmount(bonus, bonus.key, facility, context);
          if (addedLimit <= 0) {
            return facilityBest;
          }
          const bestEffectScore = operator.skills
            .filter((skill) => skill.unlockPhase <= elite)
            .flatMap((skill) => skill.effects)
            .filter((effect) => !effect.ignoredForOptimization)
            .filter((effect) => effectMatchesFacility(effect, facility))
            .flatMap((effect) => facilityStatScalingsForEffect(effect, operator, elite, facility, preference, context))
            .filter((scaling) => scaling.key === bonus.key)
            .reduce(
              (best, scaling) =>
                Math.max(best, statScalingDelta(scaling, addedLimit) * scaling.efficiencyPerStep * scaling.scorePerEfficiency),
              0
            );
          return Math.max(facilityBest, bestEffectScore);
        }, 0);
      return operatorSum + bestAssignmentScore;
    }, 0);
    return sum + beneficiaryScore;
  }, 0);
}

function remoteFacilityEfficiencyScore(
  bonuses: NonNullable<Assignment["remoteFacilityEfficiencyBonuses"]>,
  preference: OptimizationPreference,
  context?: AssignmentEvaluationContext
) {
  if (!context) {
    return 0;
  }
  return bonuses.reduce((sum, bonus) => {
    return (
      sum +
      context.facilities
        .filter((facility) => facility.type !== "dormitory" && facility.type === bonus.facility && (!bonus.product || facility.product === bonus.product))
        .reduce(
          (facilitySum, facility) =>
            facilitySum + remoteFacilityEfficiencyBonusAmount(bonus, facility, context) * productWeight(facility.product, preference) * facilityWeight(facility),
          0
        )
    );
  }, 0);
}

function remoteFacilityCountScore(
  bonuses: NonNullable<Assignment["remoteFacilityCountBonuses"]>,
  sourceOperatorId: string,
  preference: OptimizationPreference,
  context?: AssignmentEvaluationContext
) {
  if (!context) {
    return 0;
  }

  return bonuses.reduce((sum, bonus) => {
    const beneficiaryScore = operators.reduce((operatorSum, operator) => {
      if (operator.id === sourceOperatorId) {
        return operatorSum;
      }
      const rosterEntry = context.roster?.[operator.id];
      if (!rosterEntry?.owned) {
        return operatorSum;
      }
      const elite = clampEliteForOperator(operator, rosterEntry.elite);
      const bestAssignmentScore = context.facilities
        .filter((facility) => facility.type !== "dormitory")
        .reduce((facilityBest, facility) => {
          const bestEffectScore = operator.skills
            .filter((skill) => skill.unlockPhase <= elite)
            .flatMap((skill) => skill.effects)
            .filter((effect) => !effect.ignoredForOptimization)
            .filter((effect) => effectMatchesFacility(effect, facility))
            .filter((effect) => effect.scaling?.type === "facilityCount" && effect.scaling.facility === bonus.facility)
            .reduce(
              (best, effect) =>
                Math.max(best, bonus.amount * effect.efficiency * productWeight(facility.product, preference) * facilityWeight(facility)),
              0
            );
          return Math.max(facilityBest, bestEffectScore);
        }, 0);
      return operatorSum + bestAssignmentScore;
    }, 0);
    return sum + beneficiaryScore;
  }, 0);
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

function globalEffectTargetScoreMultiplier(
  effect: BaseSkillEffect,
  preference: OptimizationPreference,
  context?: AssignmentEvaluationContext
) {
  if (!effect.globalEffect || !context) {
    return 0;
  }

  return context.facilities
    .filter((facility) => facility.type !== "dormitory" && globalEffectMatchesFacility(effect, facility))
    .reduce((sum, facility) => sum + productWeight(facility.product, preference) * facilityWeight(facility), 0);
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
  const shortPlans = facilityPlans.filter((plan) => facilitySlotOccupancy(plan.assignments) < plan.facility.slotCount);

  if (shortPlans.length > 0) {
    warnings.push("一部施設でスロット数に対して候補オペレーターが不足しています。所有設定か昇進段階を見直してください。");
  }

  return warnings;
}
