import { describe, expect, it } from "vitest";
import type { FormulaBenchmark, ResourceOutputBenchmark } from "./optimizerBenchmark";
import {
  compareOptimizerBenchmarkProvenance,
  type OptimizerBenchmarkMetadataObservation
} from "./optimizerBenchmarkProvenance";

const REFERENCE_VERSION = "jp-reference-v7";
const RUNTIME_COMMIT = "7faf192d15eeac8b236c561a1938679f4642279e";

function resourceBenchmark(
  roster: ResourceOutputBenchmark["roster"] = {
    mode: "explicit",
    operatorIds: ["char_b", "char_a"]
  }
): ResourceOutputBenchmark {
  return {
    kind: "resource-output",
    scope: "facility-team",
    id: "jp-provenance-example",
    region: "JP",
    referenceProvenance: { version: REFERENCE_VERSION, observedAt: "2026-08-06" },
    runtimeDataProvenance: { operatorAvailabilitySourceCommit: RUNTIME_COMMIT },
    confidence: "disputed",
    sources: [{
      url: "https://example.com/reference",
      title: "Reference",
      accessedAt: "2026-08-06",
      language: "ja",
      role: "throughput"
    }],
    assumptions: {
      layout: "243",
      drones: "excluded",
      facilityProducts: ["lmd"],
      objectiveProfile: "lmd",
      notes: []
    },
    roster,
    rotation: { cycleHours: 24, shifts: [] },
    expected: {
      output: { lmd: 1 },
      formulas: ["lmd = 1"],
      tolerance: { type: "absolute", value: 0 }
    }
  };
}

function exactObservation(): OptimizerBenchmarkMetadataObservation {
  return {
    region: "JP",
    referenceProvenance: { version: REFERENCE_VERSION },
    runtimeDataProvenance: { operatorAvailabilitySourceCommit: RUNTIME_COMMIT },
    roster: { mode: "explicit", operatorIds: ["char_a", "char_b"] }
  };
}

describe("compareOptimizerBenchmarkProvenance", () => {
  it("reports an exact JP metadata match in stable path order", () => {
    expect(compareOptimizerBenchmarkProvenance(resourceBenchmark(), exactObservation())).toEqual([
      {
        category: "reference",
        path: "metadata/reference-provenance/version",
        severity: "info",
        passed: true,
        expected: REFERENCE_VERSION,
        actual: REFERENCE_VERSION
      },
      {
        category: "source-data",
        path: "metadata/runtime-data-provenance/region",
        severity: "info",
        passed: true,
        expected: "JP",
        actual: "JP"
      },
      {
        category: "source-data",
        path: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit",
        severity: "info",
        passed: true,
        expected: RUNTIME_COMMIT,
        actual: RUNTIME_COMMIT
      },
      {
        category: "source-data",
        path: "metadata/runtime-data-provenance/roster/mode",
        severity: "info",
        passed: true,
        expected: "explicit",
        actual: "explicit"
      },
      {
        category: "source-data",
        path: "metadata/runtime-data-provenance/roster/operatorIds",
        severity: "info",
        passed: true,
        expected: ["char_a", "char_b"],
        actual: ["char_a", "char_b"]
      }
    ]);
  });

  it("reports a wrong runtime commit at the smallest source-data mismatch path", () => {
    const observation = exactObservation();
    observation.runtimeDataProvenance = { operatorAvailabilitySourceCommit: "wrong-runtime" };

    expect(compareOptimizerBenchmarkProvenance(resourceBenchmark(), observation)[2]).toEqual({
      category: "source-data",
      path: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit",
      severity: "error",
      passed: false,
      expected: RUNTIME_COMMIT,
      actual: "wrong-runtime",
      smallestMismatchPath: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit"
    });
  });

  it("does not substitute matching reference text for an omitted runtime commit", () => {
    const observation = exactObservation();
    delete observation.runtimeDataProvenance;

    expect(compareOptimizerBenchmarkProvenance(resourceBenchmark(), observation)[2]).toEqual({
      category: "source-data",
      path: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit",
      severity: "error",
      passed: false,
      expected: RUNTIME_COMMIT,
      actual: undefined,
      smallestMismatchPath: "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit"
    });
  });

  it("compares distinct independently observed reference and runtime values", () => {
    const benchmark = resourceBenchmark();
    benchmark.referenceProvenance.version = "reference-text-version";
    benchmark.runtimeDataProvenance.operatorAvailabilitySourceCommit = "runtime-data-commit";

    const diagnostics = compareOptimizerBenchmarkProvenance(benchmark, {
      region: "JP",
      referenceProvenance: { version: "wrong-reference" },
      runtimeDataProvenance: { operatorAvailabilitySourceCommit: "runtime-data-commit" },
      roster: { mode: "explicit", operatorIds: ["char_a", "char_b"] }
    });

    expect(diagnostics[0]).toMatchObject({
      category: "reference",
      path: "metadata/reference-provenance/version",
      severity: "error",
      passed: false,
      expected: "reference-text-version",
      actual: "wrong-reference"
    });
    expect(diagnostics[2]).toMatchObject({
      category: "source-data",
      passed: true,
      expected: "runtime-data-commit",
      actual: "runtime-data-commit"
    });
  });

  it("reports a wrong region before later source-data mismatches", () => {
    const observation = exactObservation();
    observation.region = "CN";
    observation.runtimeDataProvenance = { operatorAvailabilitySourceCommit: "wrong-runtime" };

    const diagnostics = compareOptimizerBenchmarkProvenance(resourceBenchmark(), observation);

    expect(diagnostics[1]).toMatchObject({
      severity: "error",
      passed: false,
      expected: "JP",
      actual: "CN",
      smallestMismatchPath: "metadata/runtime-data-provenance/region"
    });
    expect(diagnostics[2]).not.toHaveProperty("smallestMismatchPath");
  });

  it("compares explicit rosters as sets while rejecting duplicates, missing, and extra IDs deterministically", () => {
    const reordered = exactObservation();
    reordered.roster = { mode: "explicit", operatorIds: ["char_b", "char_a"] };
    expect(compareOptimizerBenchmarkProvenance(resourceBenchmark(), reordered)[4].passed).toBe(true);

    const mismatched = exactObservation();
    mismatched.roster = {
      mode: "explicit",
      operatorIds: ["char_c", "char_a", "char_a"]
    };
    expect(compareOptimizerBenchmarkProvenance(resourceBenchmark(), mismatched)[4]).toEqual({
      category: "source-data",
      path: "metadata/runtime-data-provenance/roster/operatorIds",
      severity: "error",
      passed: false,
      expected: ["char_a", "char_b"],
      actual: ["char_a", "char_a", "char_c"],
      smallestMismatchPath: "metadata/runtime-data-provenance/roster/operatorIds"
    });
  });

  it("compares only roster mode for all-unlocked fixtures", () => {
    const diagnostics = compareOptimizerBenchmarkProvenance(
      resourceBenchmark({ mode: "all-unlocked" }),
      {
        region: "JP",
        runtimeDataProvenance: { operatorAvailabilitySourceCommit: RUNTIME_COMMIT },
        roster: { mode: "all-unlocked" }
      }
    );

    expect(diagnostics.map(({ path }) => path)).toEqual([
      "metadata/reference-provenance/version",
      "metadata/runtime-data-provenance/region",
      "metadata/runtime-data-provenance/operatorAvailabilitySourceCommit",
      "metadata/runtime-data-provenance/roster/mode"
    ]);
    expect(diagnostics[0]).toMatchObject({ severity: "info", passed: true, actual: undefined });
  });

  it("does not invent runtime or roster diagnostics for formula/GLOBAL benchmarks", () => {
    const benchmark: FormulaBenchmark = {
      kind: "formula",
      id: "global-formula",
      region: "GLOBAL",
      referenceProvenance: { version: "formula-v1", observedAt: "2026-08-06" },
      confidence: "confirmed",
      sources: [],
      assumptions: {
        layout: "243",
        drones: "not-applicable",
        facilityProducts: ["gold"],
        objectiveProfile: "formula-only",
        notes: []
      },
      formulas: [{ id: "one", expression: "1", expectedValue: 1, unit: "count" }]
    };

    expect(compareOptimizerBenchmarkProvenance(benchmark, { region: "GLOBAL" })).toEqual([{
      category: "reference",
      path: "metadata/reference-provenance/version",
      severity: "info",
      passed: true,
      expected: "formula-v1",
      actual: undefined
    }]);
  });

  it("does not mutate the fixture or observation", () => {
    const benchmark = resourceBenchmark();
    const observation = exactObservation();
    const benchmarkBefore = structuredClone(benchmark);
    const observationBefore = structuredClone(observation);

    compareOptimizerBenchmarkProvenance(benchmark, observation);

    expect(benchmark).toEqual(benchmarkBefore);
    expect(observation).toEqual(observationBefore);
  });
});
