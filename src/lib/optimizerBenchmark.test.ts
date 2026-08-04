import { describe, expect, it } from "vitest";
import { optimizerBenchmarkFixtures } from "../data/optimizer-benchmarks";
import { isPassFailEligible, validateOptimizerBenchmark } from "./optimizerBenchmark";

const validResourceBenchmark = () => ({
  kind: "resource-output",
  scope: "facility-team",
  id: "example-output",
  region: "JP",
  referenceProvenance: { version: "example composition v1", observedAt: "2026-08-04" },
  runtimeDataProvenance: { operatorAvailabilitySourceCommit: "jp-runtime-commit" },
  confidence: "corroborated",
  sources: [
    {
      url: "https://example.com/source",
      title: "Example source",
      accessedAt: "2026-08-04",
      language: "en",
      role: "throughput"
    }
  ],
  assumptions: {
    layout: "243",
    drones: "excluded",
    facilityProducts: ["lmd"],
    objectiveProfile: "lmd",
    notes: ["A documented assumption"]
  },
  roster: { mode: "explicit", operatorIds: ["char_example"] },
  rotation: {
    cycleHours: 24,
    shifts: [
      {
        id: "shift-1",
        durationHours: 24,
        assignments: { "trading-1": { operatorIds: ["char_example"] } }
      }
    ]
  },
  expected: {
    output: { lmd: 100 },
    formulas: ["lmd = 100"],
    tolerance: { type: "absolute", value: 0 }
  }
});

describe("validateOptimizerBenchmark", () => {
  it("accepts a minimal valid formula benchmark", () => {
    const result = validateOptimizerBenchmark({
      kind: "formula",
      id: "example-formula",
      region: "GLOBAL",
      referenceProvenance: { version: "example formula v1", observedAt: "2026-08-04" },
      confidence: "confirmed",
      sources: [
        {
          url: "https://example.com/source",
          title: "Example source",
          accessedAt: "2026-08-04",
          language: "en",
          role: "formula"
        }
      ],
      assumptions: {
        layout: "243",
        drones: "not-applicable",
        facilityProducts: ["gold"],
        objectiveProfile: "formula-only",
        notes: ["A documented assumption"]
      },
      formulas: [{ id: "constant", expression: "1", expectedValue: 1, unit: "count" }]
    });

    expect(result.ok).toBe(true);
  });

  it("accepts a valid resource-output benchmark", () => {
    expect(validateOptimizerBenchmark(validResourceBenchmark()).ok).toBe(true);
  });

  it.each([
    ["region", { region: "KR" }],
    ["confidence", { confidence: "likely" }],
    ["reference provenance", { referenceProvenance: { version: "example", observedAt: "August 4" } }],
    ["sources", { sources: [{ url: "not-a-url" }] }],
    ["assumptions", { assumptions: { layout: "153" } }]
  ])("rejects malformed %s metadata", (_field, replacement) => {
    expect(validateOptimizerBenchmark({ ...validResourceBenchmark(), ...replacement }).ok).toBe(false);
  });

  it("rejects the old ambiguous version metadata instead of migrating it implicitly", () => {
    const benchmark = validResourceBenchmark() as Record<string, unknown>;
    delete benchmark.referenceProvenance;
    benchmark.version = { gameDataVersion: "could-be-reference-or-runtime", observedAt: "2026-08-04" };

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "version is ambiguous; use referenceProvenance and runtimeDataProvenance"
      ])
    }));
  });

  it("accepts distinct reference and runtime provenance without substituting either string", () => {
    const benchmark = validResourceBenchmark();

    expect(benchmark.referenceProvenance.version).not.toBe(
      benchmark.runtimeDataProvenance.operatorAvailabilitySourceCommit
    );
    expect(validateOptimizerBenchmark(benchmark).ok).toBe(true);
  });

  it("rejects shifts whose durations do not match the cycle", () => {
    const benchmark = validResourceBenchmark();
    benchmark.rotation.shifts[0].durationHours = 12;

    expect(validateOptimizerBenchmark(benchmark).ok).toBe(false);
  });

  it.each([-1, Number.POSITIVE_INFINITY, Number.NaN])("rejects invalid resource output %s", (lmd) => {
    const benchmark = validResourceBenchmark();
    benchmark.expected.output.lmd = lmd;

    expect(validateOptimizerBenchmark(benchmark).ok).toBe(false);
  });

  it("rejects an explicit roster without operator IDs", () => {
    const benchmark = validResourceBenchmark();
    benchmark.roster = { mode: "explicit", operatorIds: [] };

    expect(validateOptimizerBenchmark(benchmark).ok).toBe(false);
  });

  it("validates the relative-tolerance zero fallback", () => {
    const benchmark = validResourceBenchmark();
    benchmark.expected.output.lmd = 0;
    Object.assign(benchmark.expected.tolerance, {
      type: "relative",
      value: 0.01,
      zeroExpectedAbsolute: 0.25
    });

    expect(validateOptimizerBenchmark(benchmark).ok).toBe(true);

    Object.assign(benchmark.expected.tolerance, { zeroExpectedAbsolute: -1 });
    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "expected.tolerance.zeroExpectedAbsolute must be a finite non-negative number for relative tolerance"
      ])
    }));
  });

  it("requires a zero fallback when relative tolerance covers an expected zero", () => {
    const benchmark = validResourceBenchmark();
    benchmark.expected.output.lmd = 0;
    Object.assign(benchmark.expected.tolerance, { type: "relative", value: 0.01 });

    expect(validateOptimizerBenchmark(benchmark)).toEqual(expect.objectContaining({
      ok: false,
      errors: expect.arrayContaining([
        "expected.tolerance.zeroExpectedAbsolute is required when an expected resource is zero"
      ])
    }));
  });

  it("validates explicitly declared equivalent compositions", () => {
    const benchmark = validResourceBenchmark();
    Object.assign(benchmark.expected, {
      equivalentCompositions: [{
        shifts: [{
          shiftId: "shift-1",
          assignments: { "trading-1": ["char_alternative"] }
        }]
      }]
    });

    expect(validateOptimizerBenchmark(benchmark).ok).toBe(true);

    Object.assign(benchmark.expected, {
      equivalentCompositions: [{
        shifts: [{ shiftId: "missing", assignments: { "trading-1": [] } }]
      }]
    });
    expect(validateOptimizerBenchmark(benchmark).ok).toBe(false);
  });
});

describe("isPassFailEligible", () => {
  it.each([
    ["confirmed", true],
    ["corroborated", true],
    ["disputed", false]
  ] as const)("maps %s confidence to %s", (confidence, eligible) => {
    expect(isPassFailEligible({ confidence })).toBe(eligible);
  });
});

describe("checked-in optimizer benchmark fixtures", () => {
  it("loads every fixture offline and validates it", () => {
    const results = optimizerBenchmarkFixtures.map(validateOptimizerBenchmark);

    expect(results.filter((result) => !result.ok)).toEqual([]);
    expect(results.flatMap((result) => (result.ok ? [result.value.id] : []))).toEqual([
      "jp-243-factory-3group-2025-11",
      "jp-glasgow-trading-125",
      "cn-243-3shift-2026-06",
      "base-mechanics-2026-07"
    ]);
  });

  it("keeps the disputed Glasgow case out of pass/fail eligibility", () => {
    const glasgow = optimizerBenchmarkFixtures
      .map(validateOptimizerBenchmark)
      .find((result) => result.ok && result.value.id === "jp-glasgow-trading-125");

    expect(glasgow?.ok && isPassFailEligible(glasgow.value)).toBe(false);
  });

  it("gives resource fixtures runtime boundaries without inventing one for the formula fixture", () => {
    const fixtures = optimizerBenchmarkFixtures.map(validateOptimizerBenchmark);
    const validFixtures = fixtures.flatMap((result) => result.ok ? [result.value] : []);
    const formula = validFixtures.find((fixture) => fixture.kind === "formula");
    const resources = validFixtures.filter((fixture) => fixture.kind === "resource-output");

    expect(resources).toHaveLength(3);
    expect(resources.every((fixture) => fixture.runtimeDataProvenance !== undefined)).toBe(true);
    expect(formula?.runtimeDataProvenance).toBeUndefined();
  });
});
