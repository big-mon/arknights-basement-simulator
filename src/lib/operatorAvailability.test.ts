import { describe, expect, it } from "vitest";
import operators from "../data/operators.json";
import {
  availableOperatorIds,
  availableOperators,
  createRegionalBenchmarkRoster,
  createRegionalBenchmarkStateView,
  isOperatorAvailable,
  operatorAvailabilitySnapshot,
  validateOperatorAvailabilitySnapshot
} from "./operatorAvailability";

const cnOnlyOperatorIds = [
  "char_1048_orchd2",
  "char_1049_catap2",
  "char_1051_headb2",
  "char_4031_liesel",
  "char_4037_demetr",
  "char_4215_buddy",
  "char_4225_tanya",
  "char_4226_veen",
  "char_4227_gallus",
  "char_4228_closur"
] as const;

const newlyPinnedCnOnlyOperatorIds = [
  "char_1015_aglna2",
  "char_4229_aphris",
  "char_4230_mcnist",
  "char_4235_thumpy",
  "char_4236_tmslot",
  "char_4237_jcinta"
] as const;

const catalogOperatorIds = operators.map((operator) => operator.id);

describe("checked-in operator availability snapshot", () => {
  it("keeps the pinned JP and CN availability sets separate", () => {
    expect(availableOperatorIds(operatorAvailabilitySnapshot, "JP")).toHaveLength(405);
    expect(availableOperatorIds(operatorAvailabilitySnapshot, "CN")).toHaveLength(425);
    expect(availableOperators(operatorAvailabilitySnapshot, "JP", operators)).toHaveLength(315);
    expect(isOperatorAvailable(operatorAvailabilitySnapshot, "JP", "char_436_whispr")).toBe(true);
    expect(isOperatorAvailable(operatorAvailabilitySnapshot, "CN", "char_436_whispr")).toBe(true);
  });

  it("intersects authoritative availability with the supplied modeled operators", () => {
    const suppliedOperators = [
      { id: "char_002_amiya", modeled: true },
      { id: "char_1052_kalts2", modeled: true }
    ];

    expect(availableOperators(operatorAvailabilitySnapshot, "JP", suppliedOperators)).toEqual([
      suppliedOperators[0]
    ]);
  });

  it.each(["char_2014_nian", "char_473_mberry"])(
    "includes source-authoritative JP operator %s even when absent from the optimizer catalog",
    (operatorId) => {
      expect(catalogOperatorIds).not.toContain(operatorId);
      expect(isOperatorAvailable(operatorAvailabilitySnapshot, "JP", operatorId)).toBe(true);
    }
  );

  it("keeps each region bounded by its pinned character table and sorted by ID", () => {
    const jpIds = availableOperatorIds(operatorAvailabilitySnapshot, "JP");
    const cnIds = availableOperatorIds(operatorAvailabilitySnapshot, "CN");

    expect(jpIds).toEqual([...jpIds].sort());
    expect(cnIds).toEqual([...cnIds].sort());
    expect(jpIds).not.toContain("char_1052_kalts2");
    expect(cnIds).toContain("char_1052_kalts2");
  });

  it.each(cnOnlyOperatorIds)("marks %s as CN-only", (operatorId) => {
    expect(isOperatorAvailable(operatorAvailabilitySnapshot, "JP", operatorId)).toBe(false);
    expect(isOperatorAvailable(operatorAvailabilitySnapshot, "CN", operatorId)).toBe(true);
  });

  it.each(newlyPinnedCnOnlyOperatorIds)("includes newly pinned CN-only operator %s", (operatorId) => {
    expect(isOperatorAvailable(operatorAvailabilitySnapshot, "JP", operatorId)).toBe(false);
    expect(isOperatorAvailable(operatorAvailabilitySnapshot, "CN", operatorId)).toBe(true);
  });

  it("does not assume an unknown operator ID is available in either region", () => {
    expect(isOperatorAvailable(operatorAvailabilitySnapshot, "JP", "char_unknown")).toBe(false);
    expect(isOperatorAvailable(operatorAvailabilitySnapshot, "CN", "char_unknown")).toBe(false);
  });
});

describe("regional benchmark views", () => {
  it("forces a CN-only operator to unowned in JP without mutating the input roster", () => {
    const roster = {
      char_002_amiya: { owned: true, elite: 2 as const, level: 90, potential: 1, moduleEnabled: false },
      char_4228_closur: { owned: true, elite: 2 as const, level: 90, potential: 1, moduleEnabled: false }
    };

    const filtered = createRegionalBenchmarkRoster(roster, operatorAvailabilitySnapshot, "JP");

    expect(filtered.char_002_amiya.owned).toBe(true);
    expect(filtered.char_4228_closur.owned).toBe(false);
    expect(filtered).not.toBe(roster);
    expect(filtered.char_4228_closur).not.toBe(roster.char_4228_closur);
    expect(roster.char_4228_closur.owned).toBe(true);
  });

  it("constructs a state view with the filtered roster and preserves the input state", () => {
    const state = {
      label: "benchmark",
      roster: {
        char_4228_closur: { owned: true, elite: 2 as const, level: 90, potential: 1, moduleEnabled: false }
      }
    };

    const filtered = createRegionalBenchmarkStateView(state, operatorAvailabilitySnapshot, "JP");

    expect(filtered).not.toBe(state);
    expect(filtered.label).toBe("benchmark");
    expect(filtered.roster.char_4228_closur.owned).toBe(false);
    expect(state.roster.char_4228_closur.owned).toBe(true);
  });
});

describe("validateOperatorAvailabilitySnapshot", () => {
  it("accepts a structurally valid source-authoritative ID without an optimizer catalog", () => {
    const snapshot = structuredClone(operatorAvailabilitySnapshot) as any;
    const sourceAuthoritativeId = "char_9999_source";
    expect(catalogOperatorIds).not.toContain(sourceAuthoritativeId);
    snapshot.regions.JP.operatorIds.push(sourceAuthoritativeId);
    snapshot.regions.JP.operatorIds.sort();

    expect(validateOperatorAvailabilitySnapshot(snapshot)).toEqual({ ok: true, value: snapshot });
  });

  it("rejects a malformed operator ID", () => {
    const malformed = structuredClone(operatorAvailabilitySnapshot) as any;
    malformed.regions.JP.operatorIds[0] = "operator_002_amiya";

    const result = validateOperatorAvailabilitySnapshot(malformed);

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors).toContain(
      "regions.JP.operatorIds contains malformed operator ID operator_002_amiya"
    );
  });

  it("rejects a duplicate operator ID", () => {
    const malformed = structuredClone(operatorAvailabilitySnapshot) as any;
    malformed.regions.JP.operatorIds.splice(1, 0, malformed.regions.JP.operatorIds[0]);

    const result = validateOperatorAvailabilitySnapshot(malformed);

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors).toContain(
      `regions.JP.operatorIds contains duplicate operator ID ${malformed.regions.JP.operatorIds[0]}`
    );
  });

  it("rejects operator IDs that are not in strict ascending order", () => {
    const malformed = structuredClone(operatorAvailabilitySnapshot) as any;
    [malformed.regions.JP.operatorIds[0], malformed.regions.JP.operatorIds[1]] = [
      malformed.regions.JP.operatorIds[1],
      malformed.regions.JP.operatorIds[0]
    ];

    const result = validateOperatorAvailabilitySnapshot(malformed);

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors).toContain(
      "regions.JP.operatorIds must be in strict ascending order"
    );
  });

  it.each([
    ["unknown region", (snapshot: any) => { snapshot.regions.KR = structuredClone(snapshot.regions.JP); }],
    ["invalid URL", (snapshot: any) => { snapshot.regions.JP.source.url = "not-a-url"; }],
    ["missing commit", (snapshot: any) => { delete snapshot.regions.JP.source.commit; }],
    ["invalid observed timestamp", (snapshot: any) => { snapshot.regions.JP.source.observedAt = "2026-08-01"; }]
  ])("rejects malformed metadata: %s", (_label, mutate) => {
    const malformed = structuredClone(operatorAvailabilitySnapshot) as any;
    mutate(malformed);

    expect(validateOperatorAvailabilitySnapshot(malformed).ok).toBe(false);
  });
});
