import { beforeAll, describe, expect, it } from "vitest";
import jpFactory from "../data/optimizer-benchmarks/jp-243-factory-3group-2025-11.json";
import cnFullBase from "../data/optimizer-benchmarks/cn-243-3shift-2026-06.json";
import { createDefaultState } from "../data/defaults";
import { optimizerBenchmarkFixtures } from "../data/optimizer-benchmarks";
import { averageEffectEfficiency, generateAssignmentPlan } from "./optimizer";
import { operatorAvailabilitySnapshot } from "./operatorAvailability";
import { createIssue27CurrentObservations, createIssue27OptimizerObservation } from "./optimizerIssue27Audit";
import { formatOptimizerBenchmarkBatchResult, runOptimizerBenchmarkBatch } from "./optimizerBenchmarkRunner";
import type { BenchmarkObservationMap, OptimizerBenchmarkBatchResult } from "./optimizerBenchmarkRunner";

describe("Issue #27 current-implementation audit", () => {
  let observations: BenchmarkObservationMap;
  let result: OptimizerBenchmarkBatchResult;

  beforeAll(() => {
    observations = createIssue27CurrentObservations();
    result = runOptimizerBenchmarkBatch(optimizerBenchmarkFixtures, observations);
  });

  it("reports every checked-in fixture with deterministic gating diagnostics", () => {
    expect(formatOptimizerBenchmarkBatchResult(result)).toBe([
      "optimizer benchmarks: FAILED (passed=0 failed=1 not-run=0 non-gating=4 invalid=0)",
      "NON-GATING jp-243-factory-3group-2025-11",
      "NON-GATING jp-glasgow-trading-125",
      "NON-GATING cn-243-3shift-2026-06",
      "NON-GATING base-mechanics-2026-07",
      "FAIL jp-wikiru-backup38-12h-v2 rotation/state-model/cycleHours: expected 36, actual 24"
    ].join("\n"));
  });

  it("separates informational reference provenance from the proven runtime boundaries", () => {
    const jpCase = result.cases.find((item) => item.id === "jp-243-factory-3group-2025-11");
    const cnCase = result.cases.find((item) => item.id === "cn-243-3shift-2026-06");

    expect(jpCase?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "metadata/reference-provenance/version",
        severity: "info",
        expected: "Wikiru backup 38 (2025-11-02 18:43:20)",
        actual: undefined
      }),
      expect.objectContaining({
        path: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit",
        passed: true,
        expected: "7faf192d15eeac8b236c561a1938679f4642279e",
        actual: "7faf192d15eeac8b236c561a1938679f4642279e"
      })
    ]));
    expect(cnCase?.diagnostics).toContainEqual(expect.objectContaining({
      path: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit",
      passed: true,
      expected: "81c6d458a1778a9ba878a95c4e6fe48fb4254041"
    }));
  });

  it("locks the smallest reproducible 3-group versus 2-window state mismatch", () => {
    expect(jpFactory.rotation.shifts).toHaveLength(3);
    expect(cnFullBase.rotation.shifts).toHaveLength(3);
    expect(observations["jp-243-factory-3group-2025-11"]?.rotation).toMatchObject({
      cycleHours: 24,
      shifts: [{ id: "current-window-1", durationHours: 12 }, { id: "current-window-2", durationHours: 12 }]
    });
    expect(observations["cn-243-3shift-2026-06"]?.rotation?.shifts).toHaveLength(2);
    expect(observations["jp-wikiru-backup38-12h-v2"]?.rotation).toMatchObject({
      cycleHours: 24,
      shifts: [{ id: "current-window-1", durationHours: 12 }, { id: "current-window-2", durationHours: 12 }]
    });
  });

  it("keeps unavailable quantities missing and CN source conflicts diagnostic", () => {
    expect(observations["jp-243-factory-3group-2025-11"]?.resources).toBeUndefined();
    expect(observations["cn-243-3shift-2026-06"]?.resources).toBeUndefined();
    expect(observations["jp-wikiru-backup38-12h-v2"]?.resources).toBeUndefined();
    expect(result.cases.find((item) => item.id === "cn-243-3shift-2026-06")?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "reference/source-only/shift-1/office-1/char_1052_kalts2",
          severity: "info",
          message: "source-only operator is excluded from runnable composition matching"
        }),
        expect.objectContaining({
          path: "reference/conflict/rotation.shifts.durationHours",
          severity: "info",
          expected: "12 hours per queue",
          actual: "8 hours per shift"
        }),
        expect.objectContaining({ path: "calculation/resource-values/lmd", actual: undefined })
      ])
    );
    expect(result.cases.find((item) => item.id === "cn-243-3shift-2026-06")?.diagnostics).not.toContainEqual(
      expect.objectContaining({ message: "reference composition is label-only and is not independently identified" })
    );
  });

  it("keeps disputed and formula-only references diagnostic while the accepted contract gates", () => {
    for (const id of [
      "jp-243-factory-3group-2025-11",
      "jp-glasgow-trading-125",
      "cn-243-3shift-2026-06",
      "base-mechanics-2026-07"
    ]) {
      expect(result.cases.find((item) => item.id === id)).toMatchObject({ status: "non-gating", gating: false });
    }
    expect(result.cases.find((item) => item.id === "jp-wikiru-backup38-12h-v2")).toMatchObject({
      status: "failed",
      gating: true,
      smallestMismatchPath: "rotation/state-model/cycleHours"
    });
  });

  it("derives all-unlocked metadata and provenance from the state snapshot consumed by the plan", () => {
    const jp = createIssue27OptimizerObservation("JP");
    const cn = createIssue27OptimizerObservation("CN");

    expect(jp.metadata).toEqual({
      region: "JP",
      runtimeDataProvenance: {
        operatorAvailabilitySourceCommit: operatorAvailabilitySnapshot.regions.JP.source.commit
      },
      roster: { mode: "all-unlocked" }
    });
    expect(cn.metadata).toEqual({
      region: "CN",
      runtimeDataProvenance: {
        operatorAvailabilitySourceCommit: operatorAvailabilitySnapshot.regions.CN.source.commit
      },
      roster: { mode: "all-unlocked" }
    });
  });

  it("derives explicit metadata from actual region-available ownership with no caller roster declaration", () => {
    const configuredIds = ["char_4110_delphn", "char_154_morgan", "char_112_siege", "not-in-state"];
    const expectedIds = operatorAvailabilitySnapshot.regions.JP.operatorIds.filter((operatorId) =>
      configuredIds.includes(operatorId)
    );
    const createWithIgnoredDeclaration = createIssue27OptimizerObservation as unknown as (
      region: "JP",
      operatorIds: readonly string[],
      ignoredRosterDeclaration: unknown
    ) => BenchmarkObservationMap[string];
    const observation = createWithIgnoredDeclaration("JP", configuredIds, {
      mode: "all-unlocked",
      operatorIds: ["caller-cannot-declare-metadata"]
    });

    expect(createIssue27OptimizerObservation).toHaveLength(2);
    expect(observation?.metadata).toEqual({
      region: "JP",
      runtimeDataProvenance: {
        operatorAvailabilitySourceCommit: operatorAvailabilitySnapshot.regions.JP.source.commit
      },
      roster: { mode: "explicit", operatorIds: expectedIds }
    });
  });

  it("confirms optimizer morale/time averaging still truncates fractional hours", () => {
    const effect = {
      facility: "factory" as const,
      efficiency: 0,
      description: { en: "synthetic fractional-hour audit curve" },
      timeCurve: { initialEfficiency: 0, efficiencyPerHour: 0.1, maxEfficiency: 1 }
    };

    expect(averageEffectEfficiency(effect, 2.5)).toBe(averageEffectEfficiency(effect, 2));
  });

  it("confirms generated plans do not expose quantity or sustainable-cycle results", () => {
    const plan = generateAssignmentPlan(createDefaultState());

    expect(plan).not.toHaveProperty("resourceLedger");
    expect(plan).not.toHaveProperty("goldProduced");
    expect(plan).not.toHaveProperty("battleRecordExp");
    expect(plan).not.toHaveProperty("lmd");
  });
});
