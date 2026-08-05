import type { ResourceLedger } from "./resourceLedger";

export type PlanResourceMissingCode =
  | "schedule-group-unpopulated"
  | "rotation-window-missing"
  | "schedule-active-groups-unresolved"
  | "facility-team-missing"
  | "unsupported-factory-product"
  | "unsupported-trading-order-effect"
  | "invalid-evaluated-efficiency"
  | "support-resource-unresolved"
  | "support-fixed-context-unresolved"
  | "calculator-error";

export type PlanResourceTradingEffectType =
  | "defaultedOrderRule"
  | "defaultedOrderExtraGold"
  | "highValueOrderExtraLmd"
  | "highValueOrderProbability"
  | "fixedSpecialOrder";

export interface PlanResourceMissingReason {
  code: PlanResourceMissingCode;
  path: string;
  message: string;
  operatorId?: string;
  effectId?: string;
  effectIndex?: number;
  effectType?: PlanResourceTradingEffectType;
  effectKind?: "pepe" | "closure";
  sourceId?: string;
  scheduleWindowId?: string;
  contextKey?: "dormitoryOccupancy";
  diagnosticCode?: string;
}

export interface PlanFixedSourceEvidence {
  sourceId: string;
  scheduleWindowId: string;
  operatorId: string;
  facilityId: string;
  facilityType: string;
  facilityLevel: number;
  facilitySlot: number;
  facilityCapacity: number;
  resourceKey: string;
  amount: number;
  provenance: Readonly<{ source: string; detail: string }>;
  assumptions: readonly string[];
  simplifications: readonly string[];
}

export interface PlanFixedContextEvidence {
  contextKey: "dormitoryOccupancy";
  amount: number;
  provenance: Readonly<{ source: string; detail: string }>;
  assumptions: readonly string[];
  simplifications: readonly string[];
}

export interface PlanResourceEvidence {
  fixedSources: readonly Readonly<PlanFixedSourceEvidence>[];
  fixedContexts: readonly Readonly<PlanFixedContextEvidence>[];
}

export interface PlanFacilityEfficiencyEvaluationEvidence {
  provenance:
    | "optimizer-normal-team-reevaluation-with-schedule-aware-contiguous-work-and-resolved-support-context"
    | "optimizer-normal-team-reevaluation-with-resolved-support-context";
  fixedResourceAmounts: Readonly<Record<string, number>>;
  fixedDormitoryOccupancy?: number;
}

export interface PlanFacilityResourceResult {
  facilityId: string;
  facilityType: "factory" | "trading";
  product: "gold" | "battleRecord" | "lmd";
  operatorIds: readonly string[];
  additiveEfficiency: number;
  efficiencyEvaluation?: Readonly<PlanFacilityEfficiencyEvaluationEvidence>;
  ledger: ResourceLedger;
}

export interface PlanWindowResourceResult {
  shiftId: string;
  startHour: number;
  endHour: number;
  durationHours: number;
  activeGroupIds: readonly string[];
  facilities: readonly Readonly<PlanFacilityResourceResult>[];
}

export interface PlanDroneResourceResult {
  targetFacilityId?: string;
  dronesAllocated: number;
  per24Ledger: ResourceLedger;
  semantics: Readonly<{
    allocationTimingAssumption: "slot-batch-consumption";
    capOverflowAccounting: "before-slot-allocation";
    scheduleFeasibility: "evaluated-at-slot-boundaries";
  }>;
}

export interface PlanResourceAssumptions {
  facilityProductionCalculator: "simulateFacilityProduction";
  droneCalculator: "simulateTradingPostDrones24h";
  facilityLevel: 3;
  storage: "unbounded-no-plan-state";
  teamEfficiencyProvenance: "optimizer-evaluated-facility-efficiency-for-selected-schedule-group";
  initialDrones: 0;
  droneAllocationPolicy: "all-completed-to-highest-marginal-normal-order-gain-facility-id-tiebreak";
  allocationTimingAssumption: "slot-batch-consumption";
  capOverflowAccounting: "before-slot-allocation";
  scheduleFeasibility: "evaluated-at-slot-boundaries";
  normalization: "cycle-ledger-scaled-linearly-to-24-hours";
}

export interface PlanResourceEvaluation {
  status: "complete" | "incomplete";
  assumptions: Readonly<PlanResourceAssumptions>;
  windows: readonly Readonly<PlanWindowResourceResult>[];
  missing: readonly Readonly<PlanResourceMissingReason>[];
  evidence?: Readonly<PlanResourceEvidence>;
  drone?: Readonly<PlanDroneResourceResult>;
  cycleLedger?: ResourceLedger;
  per24Ledger?: ResourceLedger;
}
