import type { SustainableCycleInput, SustainableCycleResult } from "./sustainableCycleEvaluator";

export type PlanSustainabilityMissingCode =
  | "unsupported-layout"
  | "unsupported-base-context"
  | "plan-resources-incomplete"
  | "rotation-window-missing"
  | "rotation-window-mismatch"
  | "rotation-window-incomplete"
  | "morale-consumption-unavailable"
  | "recovery-provenance-unavailable"
  | "morale-exchange-source-unavailable"
  | "morale-exchange-source-not-owned"
  | "recovery-allocation-unavailable"
  | "drone-resource-timing-unrepresentable"
  | "resource-ledger-aggregate-mismatch"
  | "morale-fixed-point-not-converged"
  | "sustainable-cycle-evaluator-error";

export interface PlanSustainabilityMissingReason {
  code: PlanSustainabilityMissingCode;
  path: string;
  message: string;
  operatorId?: string;
  sourceOperatorId?: string;
  facilityId?: string;
  shiftId?: string;
  groupId?: string;
}

export interface PlanSustainabilityAssumptions {
  startingGold: 0;
  moraleCap: 24;
  baseContext: "max-level-243-verified-4x5-dormitories";
  droneDistributionPolicy: "duration-proportional-from-strict-slot-batch-plan-ledger";
  recoveryPackingPolicy: "deterministic-interval-aware-first-fit-4x5";
  exchangeEventBoundary: "recovery-placement-start";
  fixedPointMethod: "successive-cycle-final-morale";
  fixedPointTolerance: number;
  fixedPointIterationLimit: number;
  resourceAggregateEpsilon: number;
}

export interface PlanSustainabilityConvergence {
  iterations: number;
  tolerance: number;
  maximumDelta: number;
  initialMorale: Readonly<Record<string, number>>;
}

export interface EvaluatedPlanSustainability {
  status: "evaluated";
  assumptions: Readonly<PlanSustainabilityAssumptions>;
  convergence: Readonly<PlanSustainabilityConvergence>;
  input: Readonly<SustainableCycleInput>;
  result: Readonly<SustainableCycleResult>;
  missing: readonly [];
}

export interface IncompletePlanSustainability {
  status: "incomplete";
  assumptions: Readonly<PlanSustainabilityAssumptions>;
  missing: readonly Readonly<PlanSustainabilityMissingReason>[];
}

export type PlanSustainabilityEvaluation = EvaluatedPlanSustainability | IncompletePlanSustainability;
