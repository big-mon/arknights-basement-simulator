import type { PlanResourceEvaluation } from "./lib/planResourceTypes";
import type { PlanSustainabilityEvaluation } from "./lib/planSustainabilityTypes";

export type FacilityType = "factory" | "trading" | "power" | "control" | "dormitory" | "reception";

export type ProductType = "gold" | "battleRecord" | "originium" | "lmd" | "power" | "morale" | "clue";

export type BaseSkillFamily = "rhineTech" | "pinusSylvestris" | "standardization";

export type BaseLayout = "243" | "153";

export type RotationCount = 2;

export interface ScheduleGroup {
  id: string;
}

export interface ScheduleShift {
  id: string;
  startHour: number;
  endHour: number;
  activeGroupIds: string[];
  recoveryGroupIds: string[];
}

export interface ScheduleState {
  cycleHours: number;
  groups: ScheduleGroup[];
  shifts: ScheduleShift[];
}

export type LanguageCode = "ja" | "zh" | "en";

export type AppRegion = "JP" | "CN";

export type LocalizedText = Partial<Record<LanguageCode, string>>;

export type OperatorProfession =
  | "先鋒"
  | "前衛"
  | "重装"
  | "狙撃"
  | "術師"
  | "医療"
  | "補助"
  | "特殊"
  | "その他";

export interface BaseSkillEffect {
  facility: FacilityType;
  product?: ProductType;
  efficiency: number;
  baseEfficiency?: number;
  timeCurve?: {
    initialEfficiency: number;
    efficiencyPerHour: number;
    maxEfficiency: number;
    startsAfterFirstHour?: boolean;
  };
  moraleCurve?: {
    initialEfficiency: number;
    efficiencyPerStep: number;
    moralePerStep: number;
    minEfficiency: number;
  };
  activation?: {
    type: "moraleSpent";
    threshold: number;
  };
  moraleEffects?: Array<{
    type: "consumption" | "recovery" | "immunity";
    target: "self" | "room" | "other" | "singleOther" | "dormitories" | "otherFacilities" | "conditionOperators";
    amount: number;
    mode?: "externalConsumptionEffects" | "selfConsumptionReduction";
    affiliations?: string[];
    targetAffiliations?: string[];
    targetOperatorIds?: string[];
    targetMoraleAtMost?: number;
    requiresDormitoryOperatorIds?: string[];
    stacksWithBase?: boolean;
  }>;
  moraleExchange?: {
    target: "previous";
    requiresFullMorale: true;
  };
  scaling?: {
    type:
      | "affiliation"
      | "facilityGroupAffiliation"
      | "facilityCount"
      | "facilityProductCount"
      | "facilityLevel"
      | "fixed"
      | "resource"
      | "dormitoryOccupancy"
      | "skillFamily"
      | "facilityStorageLimit"
      | "facilityOrderLimit";
    affiliations?: string[];
    facility?: FacilityType;
    product?: ProductType;
    resource?: string;
    family?: BaseSkillFamily;
    count?: number;
    per?: number;
    includeSelf?: boolean;
    max?: number;
    min?: number;
    scope?: "base" | "facility" | "sameFacility";
  };
  globalEffect?: {
    facility: FacilityType;
    product?: ProductType;
    stackKey?: string;
  };
  resourceEffects?: Array<{
    resource: string;
    amount: number;
    scaling?: NonNullable<BaseSkillEffect["scaling"]>;
  }>;
  skillFamilyConversions?: Array<{
    from: BaseSkillFamily[];
    to: BaseSkillFamily;
    scope: "sameFacility";
  }>;
  facilityCountBonuses?: Array<{
    facility: FacilityType;
    amount: number;
  }>;
  storageLimit?: number;
  orderLimit?: number;
  orderState?: {
    mode: "averageEmptySlots" | "averageStoredOrders";
    collectionIntervalHours: number;
    reduceOrderLimitPerOtherEfficiency?: number;
    minimumOrderLimit?: number;
  };
  tradingOrderEffects?: Array<
    | {
        type: "defaultedOrderRule";
      }
    | {
        type: "defaultedOrderExtraGold";
        amount: number;
      }
    | {
        type: "highValueOrderExtraLmd";
        amount: number;
      }
    | {
        type: "highValueOrderProbability";
        level: "slight" | "increased";
        warmupHours: number;
      }
    | {
        type: "fixedSpecialOrder";
        kind: "pepe" | "closure";
        gold: number;
        lmd: number;
        hours: number;
        affectedByEfficiency: boolean;
      }
  >;
  ignoredForOptimization?: boolean;
  hiddenFromUi?: boolean;
  unsupportedReason?: string;
  conditionalBonuses?: Array<{
    efficiency: number;
    conditions: BaseSkillCondition[];
  }>;
  suppressesOtherFactoryEfficiency?: boolean;
  tags?: string[];
  conditions?: BaseSkillCondition[];
  description: LocalizedText;
}

export type BaseSkillCondition =
  | {
      type: "sameFacilityOperator";
      operatorIds: string[];
    }
  | {
      type: "facilityOperator";
      facility: FacilityType;
      operatorIds: string[];
    }
  | {
      type: "assignedOperator";
      facility?: FacilityType;
      operatorIds: string[];
    }
  | {
      type: "sameFacilityAffiliation";
      affiliations: string[];
      min?: number;
    }
  | {
      type: "facilityAffiliation";
      facility?: FacilityType;
      affiliations: string[];
      min?: number;
      max?: number;
    }
  | {
      type: "facilityCount";
      facility: FacilityType;
      min?: number;
      max?: number;
    };

export interface BaseSkill {
  id: string;
  name: LocalizedText;
  slot: number;
  unlockPhase: 0 | 1 | 2;
  unlockLevel: number;
  families?: BaseSkillFamily[];
  effects: BaseSkillEffect[];
}

export interface Operator {
  id: string;
  name: LocalizedText;
  affiliations?: string[];
  rarity: 1 | 2 | 3 | 4 | 5 | 6;
  profession: OperatorProfession;
  skills: BaseSkill[];
}

export interface RosterEntry {
  owned: boolean;
  elite: 0 | 1 | 2;
  level: number;
  potential: number;
  moduleEnabled: boolean;
}

export type Roster = Record<string, RosterEntry>;

export interface FacilitySlot {
  id: string;
  type: FacilityType;
  name: string;
  slotCount: number;
  product: ProductType;
}

export interface OptimizationPreference {
  gold: number;
  battleRecord: number;
  lmd: number;
}

export interface AppState {
  language: LanguageCode;
  region: AppRegion;
  layout: BaseLayout;
  schedule: ScheduleState;
  roster: Roster;
  facilities: FacilitySlot[];
  preference: OptimizationPreference;
}

export interface Assignment {
  facilityId: string;
  operatorId: string;
  skillId: string;
  score: number;
  efficiency: number;
  storageLimit?: number;
  orderLimit?: number;
  tradingOrderEffects?: NonNullable<BaseSkillEffect["tradingOrderEffects"]>;
  suppressesOtherFactoryEfficiency?: boolean;
  globalStackKey?: string;
  globalStackKeys?: string[];
  skilllessPrerequisiteOperatorIds?: string[];
  baseSkilllessPrerequisiteOperatorIds?: string[];
  skilllessPrerequisiteFor?: string;
  baseSkilllessPrerequisiteFor?: string;
  doesNotConsumeFacilitySlot?: boolean;
  scalesWithFacilityStat?: Array<"storageLimit" | "orderLimit">;
  facilityStatScalings?: Array<{
    key: "storageLimit" | "orderLimit";
    base: number;
    current: number;
    efficiencyPerStep: number;
    scorePerEfficiency: number;
    per?: number;
    max?: number;
  }>;
  remoteFacilityStatBonuses?: Array<{
    key: "storageLimit" | "orderLimit";
    facility: FacilityType;
    amount: number;
    affiliations?: string[];
    operatorIds?: string[];
    min?: number;
  }>;
  remoteFacilityEfficiencyBonuses?: Array<{
    facility: FacilityType;
    amount: number;
    product?: ProductType;
    affiliations?: string[];
    groupAffiliations?: string[];
    operatorIds?: string[];
    min?: number;
  }>;
  remoteFacilityCountBonuses?: Array<{
    facility: FacilityType;
    amount: number;
  }>;
  fatigueHours: number;
  recoveryHours: number;
  moraleExchangeApplied?: boolean;
  moraleExchangeSourceOperatorId?: string;
  moraleConsumptionPerHour?: number;
  dormitoryRecoveryPerHour?: number;
  recoveryProvenance?: Readonly<{
    baseRecoveryRatePerHour: number;
    conditionalModifiers: readonly Readonly<{
      moraleAtMost: number;
      additionalRatePerHour: number;
      sourceOperatorIds: readonly string[];
    }>[];
    sources: readonly Readonly<{
      operatorId: string;
      role: "recovery-source" | "required-helper";
      allocation:
        | "self-no-slot"
        | "room-shareable"
        | "single-other-exclusive"
        | "cross-dormitory-working"
        | "required-helper"
        | "exchange";
      occupiesDormitorySlot: boolean;
      ownedAtEvaluation: boolean;
    }>[];
  }>;
  postZeroOutputModeled?: boolean;
  shiftUptime?: number;
  moraleEfficiencyCurves?: Array<{
    baselineEfficiency: number;
    initialEfficiency: number;
    efficiencyPerStep: number;
    moralePerStep: number;
    minEfficiency: number;
  }>;
  reason: string;
}

export interface FacilityPlan {
  facility: FacilitySlot;
  assignments: Assignment[];
  expectedEfficiency: number;
  alternativeExpectedEfficiency?: number;
  score: number;
  alternatives: Assignment[];
}

export interface RotationWindow {
  label: string;
  hours: number;
  shiftId: string;
  startHour: number;
  endHour: number;
  activeGroupIds: string[];
  recoveryGroupIds: string[];
  incompleteGroupIds: string[];
  assignments: Assignment[];
  recovery: Assignment[];
}

export interface AssignmentPlanDiagnostic {
  code: "schedule-group-unpopulated";
  message: string;
  groupId: string;
  shiftId: string;
}

export interface AssignmentPlan {
  generatedAt: string;
  totalScore: number;
  dailyValue: number;
  facilityPlans: FacilityPlan[];
  schedule: ScheduleState;
  rotation: RotationWindow[];
  diagnostics: AssignmentPlanDiagnostic[];
  resources: PlanResourceEvaluation;
  sustainability: PlanSustainabilityEvaluation;
  warnings: string[];
}
