export type FacilityType = "factory" | "trading" | "power" | "control" | "dormitory" | "reception";

export type ProductType = "gold" | "battleRecord" | "originium" | "lmd" | "power" | "morale" | "clue";

export type BaseLayout = "243" | "153";

export type RotationCount = 2 | 3;

export type LanguageCode = "ja" | "zh" | "en";

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
  scaling?: {
    type:
      | "affiliation"
      | "facilityGroupAffiliation"
      | "facilityCount"
      | "facilityProductCount"
      | "facilityLevel"
      | "fixed"
      | "resource"
      | "facilityStorageLimit"
      | "facilityOrderLimit";
    affiliations?: string[];
    facility?: FacilityType;
    product?: ProductType;
    resource?: string;
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
  storageLimit?: number;
  orderLimit?: number;
  ignoredForOptimization?: boolean;
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
  unlockPhase: 0 | 1 | 2;
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
  layout: BaseLayout;
  rotationCount: RotationCount;
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
  suppressesOtherFactoryEfficiency?: boolean;
  fatigueHours: number;
  recoveryHours: number;
  reason: string;
}

export interface FacilityPlan {
  facility: FacilitySlot;
  assignments: Assignment[];
  expectedEfficiency: number;
  score: number;
  alternatives: Assignment[];
}

export interface RotationWindow {
  label: string;
  hours: number;
  assignments: Assignment[];
  recovery: Assignment[];
}

export interface AssignmentPlan {
  generatedAt: string;
  totalScore: number;
  dailyValue: number;
  facilityPlans: FacilityPlan[];
  rotation: RotationWindow[];
  warnings: string[];
}
