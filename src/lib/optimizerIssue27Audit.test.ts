import { beforeAll, describe, expect, it } from "vitest";
import jpFactory from "../data/optimizer-benchmarks/jp-243-factory-3group-2025-11.json";
import cnFullBase from "../data/optimizer-benchmarks/cn-243-3shift-2026-06.json";
import { createDefaultState } from "../data/defaults";
import { optimizerBenchmarkFixtures } from "../data/optimizer-benchmarks";
import { averageEffectEfficiency, generateAssignmentPlan } from "./optimizer";
import { createIssue27CurrentObservations } from "./optimizerIssue27Audit";
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
      "optimizer benchmarks: FAILED (passed=1 failed=2 not-run=0 non-gating=1 invalid=0)",
      "FAIL jp-243-factory-3group-2025-11 rotation/state-model/cycleHours: expected 36, actual 24",
      "NON-GATING jp-glasgow-trading-125",
      "FAIL cn-243-3shift-2026-06 rotation/state-model/shifts/current-window-1/unexpected: expected absent, actual present",
      "PASS base-mechanics-2026-07"
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
  });

  it("keeps unavailable quantities missing and label-only compositions unproved", () => {
    expect(observations["jp-243-factory-3group-2025-11"]?.resources).toBeUndefined();
    expect(observations["cn-243-3shift-2026-06"]?.resources).toBeUndefined();
    expect(result.cases.find((item) => item.id === "cn-243-3shift-2026-06")?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "composition/search/shift-1/full-base",
          severity: "info",
          message: "reference composition is label-only and is not independently identified"
        }),
        expect.objectContaining({ path: "calculation/resource-values/lmd", actual: undefined })
      ])
    );
  });

  it("propagates AppState region through the audit's normal plan path", () => {
    const state = createDefaultState();

    expect(state.region).toBe("JP");
    expect(observations["jp-243-factory-3group-2025-11"]?.metadata.region).toBe("JP");
    expect(observations["cn-243-3shift-2026-06"]?.metadata.region).toBe("CN");
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
