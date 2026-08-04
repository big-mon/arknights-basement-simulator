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

const catalogOperatorIds = operators.map((operator) => operator.id);

describe("checked-in operator availability snapshot", () => {
  it("keeps the pinned JP and CN availability sets separate", () => {
    expect(availableOperatorIds(operatorAvailabilitySnapshot, "JP")).toHaveLength(314);
    expect(availableOperatorIds(operatorAvailabilitySnapshot, "CN")).toHaveLength(324);
    expect(availableOperators(operatorAvailabilitySnapshot, "JP", operators)).toHaveLength(314);
  });

  it.each(cnOnlyOperatorIds)("marks %s as CN-only", (operatorId) => {
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
  it("rejects an availability ID absent from the checked-in catalog", () => {
    const malformed = structuredClone(operatorAvailabilitySnapshot) as any;
    malformed.regions.JP.operatorIds.push("char_unknown");

    const result = validateOperatorAvailabilitySnapshot(malformed, catalogOperatorIds);

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors).toContain("regions.JP.operatorIds contains unknown operator ID char_unknown");
  });

  it.each([
    ["unknown region", (snapshot: any) => { snapshot.regions.KR = structuredClone(snapshot.regions.JP); }],
    ["duplicate ID", (snapshot: any) => { snapshot.regions.JP.operatorIds.push(snapshot.regions.JP.operatorIds[0]); }],
    ["invalid URL", (snapshot: any) => { snapshot.regions.JP.source.url = "not-a-url"; }],
    ["missing commit", (snapshot: any) => { delete snapshot.regions.JP.source.commit; }],
    ["invalid observed timestamp", (snapshot: any) => { snapshot.regions.JP.source.observedAt = "2026-08-01"; }]
  ])("rejects malformed metadata: %s", (_label, mutate) => {
    const malformed = structuredClone(operatorAvailabilitySnapshot) as any;
    mutate(malformed);

    expect(validateOperatorAvailabilitySnapshot(malformed, catalogOperatorIds).ok).toBe(false);
  });
});
