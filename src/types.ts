export type FacilityType = "factory" | "trading" | "power" | "control" | "dormitory";

export type ProductType = "gold" | "battleRecord" | "lmd" | "power" | "morale";

export type BaseLayout = "243" | "153";

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
  tags?: string[];
  description: string;
}

export interface BaseSkill {
  id: string;
  name: string;
  unlockPhase: 0 | 1 | 2;
  effects: BaseSkillEffect[];
}

export interface Operator {
  id: string;
  name: string;
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
  layout: BaseLayout;
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
