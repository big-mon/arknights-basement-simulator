import { describe, expect, it } from "vitest";
import baseMechanics from "../data/optimizer-benchmarks/base-mechanics-2026-07.json";
import {
  createMaxLevel243BenchmarkContext,
  validateBenchmarkBaseContext
} from "./benchmarkBaseContext";

function cloneCanonicalContext() {
  return structuredClone(createMaxLevel243BenchmarkContext());
}

describe("max-level 243 benchmark base context", () => {
  it("represents the canonical complete base without adding rooms to AppState", () => {
    const context = createMaxLevel243BenchmarkContext();

    expect(validateBenchmarkBaseContext(context)).toEqual({ ok: true, value: context });
    expect(context.layout).toBe("243");
    expect(context.facilities.filter((facility) => facility.type === "trading")).toHaveLength(2);
    expect(context.facilities.filter((facility) => facility.type === "factory")).toHaveLength(4);
    expect(context.facilities.filter((facility) => facility.type === "power")).toHaveLength(3);
    expect(context.facilities.filter((facility) => facility.type === "control")).toHaveLength(1);
    expect(context.facilities.filter((facility) => facility.type === "reception")).toHaveLength(1);
    expect(context.facilities.filter((facility) => facility.type === "office")).toHaveLength(1);
    expect(context.facilities.filter((facility) => facility.type === "workshop")).toHaveLength(1);
    expect(context.facilities.filter((facility) => facility.type === "training")).toHaveLength(1);

    const documentedDroneCap = baseMechanics.formulas.find((formula) => formula.id === "drone-cap")?.expectedValue;
    expect(context.droneCap).toBe(documentedDroneCap);
  });

  it("provides four maximum-ambience dormitories and 20 beds", () => {
    const dormitories = createMaxLevel243BenchmarkContext().facilities.filter(
      (facility) => facility.type === "dormitory"
    );

    expect(dormitories).toHaveLength(4);
    expect(dormitories.every((dormitory) => dormitory.level === 5 && dormitory.maxAmbience === 5000)).toBe(true);
    expect(dormitories.reduce((beds, dormitory) => beds + dormitory.slotCount, 0)).toBe(20);
  });

  it("uses the two-gold/two-battle-record default factory split", () => {
    const products = createMaxLevel243BenchmarkContext().facilities
      .filter((facility) => facility.type === "factory")
      .map((facility) => facility.product);

    expect(products).toEqual(["gold", "gold", "battleRecord", "battleRecord"]);
  });

  it("accepts the same facilities and factory products in a different order", () => {
    const context = cloneCanonicalContext();
    context.facilities.reverse();

    expect(validateBenchmarkBaseContext(context)).toEqual({ ok: true, value: context });
  });

  it.each([
    ["duplicate IDs", (context: ReturnType<typeof cloneCanonicalContext>) => { context.facilities[1].id = context.facilities[0].id; }, "duplicate facility ID"],
    ["wrong facility count", (context: ReturnType<typeof cloneCanonicalContext>) => { context.facilities.pop(); }, "training facilities: expected 1, received 0"],
    ["wrong level", (context: ReturnType<typeof cloneCanonicalContext>) => { context.facilities[0].level = 2; }, "trading-1.level: expected 3, received 2"],
    ["wrong slots", (context: ReturnType<typeof cloneCanonicalContext>) => { context.facilities[0].slotCount = 2; }, "trading-1.slotCount: expected 3, received 2"],
    ["wrong trading product", (context: ReturnType<typeof cloneCanonicalContext>) => {
      const trading = context.facilities.find((facility) => facility.type === "trading");
      if (trading?.type === "trading") trading.order = "orundum" as "lmd";
    }, "trading-1.order: expected lmd, received orundum"],
    ["a three-gold/one-battle-record factory split", (context: ReturnType<typeof cloneCanonicalContext>) => {
      const factory = context.facilities.find(
        (facility) => facility.type === "factory" && facility.product === "battleRecord"
      );
      if (factory?.type === "factory") factory.product = "gold";
    }, "factory products: expected exactly 2 gold and 2 battleRecord"],
    ["an unknown factory product", (context: ReturnType<typeof cloneCanonicalContext>) => {
      const factory = context.facilities.find((facility) => facility.type === "factory");
      if (factory?.type === "factory") factory.product = "unknown" as "gold";
    }, "factory products: expected exactly 2 gold and 2 battleRecord"],
    ["invalid drone cap", (context: ReturnType<typeof cloneCanonicalContext>) => { context.droneCap = -1; }, "droneCap: expected 235, received -1"]
  ])("rejects %s with an actionable error", (_label, mutate, expectedError) => {
    const context = cloneCanonicalContext();
    mutate(context);

    const result = validateBenchmarkBaseContext(context);

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors).toEqual(expect.arrayContaining([expect.stringContaining(expectedError)]));
  });
});
