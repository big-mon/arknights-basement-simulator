import { describe, expect, it } from "vitest";
import {
  simulateFacilityProduction,
  type ProductionEfficiencyEffect
} from "./facilityProduction";

const operatorEffect = (
  id: string,
  additiveEfficiency: number,
  target: ProductionEfficiencyEffect["target"] = "all"
): ProductionEfficiencyEffect => ({ id, source: "operator", additiveEfficiency, target });

describe("facility production", () => {
  describe("runtime input authority", () => {
    it.each([
      ["null input", null, /input must be a non-null object/],
      ["array input", [], /input must be a non-null object/],
      ["null facility", { durationHours: 1, facility: null }, /facility must be a non-null object/],
      ["array facility", { durationHours: 1, facility: [] }, /facility must be a non-null object/],
      [
        "unknown facility kind",
        { durationHours: 1, facility: { kind: "bogus", level: 99, orderType: "wrong" } },
        /facility\.kind is unsupported/
      ],
      [
        "wrong factory level",
        { durationHours: 1, facility: { kind: "factory", level: 1, product: "gold" } },
        /facility\.level must be 3/
      ],
      [
        "wrong factory product",
        { durationHours: 1, facility: { kind: "factory", level: 3, product: "originium" } },
        /facility\.product is unsupported/
      ],
      [
        "wrong trading-post level",
        { durationHours: 1, facility: { kind: "tradingPost", level: 2, orderType: "normalLmd" } },
        /facility\.level must be 3/
      ],
      [
        "wrong trading-post order type",
        { durationHours: 1, facility: { kind: "tradingPost", level: 3, orderType: "wrong" } },
        /facility\.orderType is unsupported/
      ]
    ])("rejects %s with RangeError", (_label, malformed, diagnostic) => {
      expect(() => simulateFacilityProduction(malformed as never)).toThrowError(RangeError);
      expect(() => simulateFacilityProduction(malformed as never)).toThrow(diagnostic);
    });

    it.each([
      ["non-array team effects", { teamEffects: {} }, /teamEffects must be an array/],
      ["null remote effects", { remoteEffects: null }, /remoteEffects must be an array/],
      ["non-array events", { efficiencyEvents: {} }, /efficiencyEvents must be an array/],
      ["null effect record", { teamEffects: [null] }, /teamEffects\[0\] must be a non-null object/],
      ["array effect record", { teamEffects: [[]] }, /teamEffects\[0\] must be a non-null object/],
      ["null event record", { efficiencyEvents: [null] }, /efficiencyEvents\[0\] must be a non-null object/],
      [
        "non-array event effects",
        { efficiencyEvents: [{ atHour: 0.5, effects: {} }] },
        /efficiencyEvents\[0\]\.effects must be an array/
      ]
    ])("rejects %s as malformed JSON with RangeError", (_label, partial, diagnostic) => {
      const malformed = {
        durationHours: 1,
        facility: { kind: "factory", level: 3, product: "gold" },
        ...partial
      };

      expect(() => simulateFacilityProduction(malformed as never)).toThrowError(RangeError);
      expect(() => simulateFacilityProduction(malformed as never)).toThrow(diagnostic);
    });
  });

  describe("verified base formulas", () => {
    it("produces level-3 gold and advanced battle records for a 12-hour shift", () => {
      const gold = simulateFacilityProduction({
        durationHours: 12,
        facility: { kind: "factory", level: 3, product: "gold" }
      });
      const records = simulateFacilityProduction({
        durationHours: 12,
        facility: { kind: "factory", level: 3, product: "battleRecord" }
      });

      expect(gold.base).toEqual({ minutesPerUnit: 72, unitsPerHour: 50 / 60 });
      expect(gold.production.potentialUnits).toBeCloseTo(10);
      expect(gold.ledger.natural.goldProduced).toBeCloseTo(10);
      expect(records.base).toEqual({ minutesPerUnit: 180, unitsPerHour: 1 / 3, expPerUnit: 1000 });
      expect(records.production.potentialUnits).toBeCloseTo(4);
      expect(records.ledger.natural.battleRecordExp).toBeCloseTo(4000);
      expect(records.ledger.drone).toEqual({ goldProduced: 0, goldConsumed: 0, battleRecordExp: 0, lmd: 0 });
    });

    it("keeps normal-order speed and expected order value as separate values", () => {
      const result = simulateFacilityProduction({
        durationHours: 12,
        facility: { kind: "tradingPost", level: 3, orderType: "normalLmd" }
      });

      expect(result.base).toEqual({ minutesPerOrder: 203.4, ordersPerHour: 60 / 203.4 });
      expect(result.orderDistribution).toEqual({
        outcomes: [
          { gold: 2, lmd: 1000, minutes: 144, probability: 0.3 },
          { gold: 3, lmd: 1500, minutes: 210, probability: 0.5 },
          { gold: 4, lmd: 2000, minutes: 276, probability: 0.2 }
        ],
        expectedGoldPerOrder: 2.9,
        expectedLmdPerOrder: 1450
      });
      expect(result.production.potentialUnits).toBeCloseTo(720 / 203.4);
      expect(result.ledger.natural.goldConsumed).toBeCloseTo((720 / 203.4) * 2.9);
      expect(result.ledger.natural.lmd).toBeCloseTo((720 / 203.4) * 1450);
    });
  });

  describe("hierarchical efficiency composition", () => {
    it("applies one synthetic verified-percentage skill", () => {
      const result = simulateFacilityProduction({
        durationHours: 12,
        facility: { kind: "factory", level: 3, product: "gold" },
        teamEffects: [operatorEffect("single-skill", 0.25)]
      });

      expect(result.efficiency.staticAdditiveEfficiency).toBe(0.25);
      expect(result.production.producedUnits).toBeCloseTo(12.5);
    });

    it("adds the effects of a three-operator facility team", () => {
      const result = simulateFacilityProduction({
        durationHours: 12,
        facility: { kind: "factory", level: 3, product: "gold" },
        teamEffects: [
          operatorEffect("team-a", 0.1),
          operatorEffect("team-b", 0.2),
          operatorEffect("team-c", 0.3)
        ]
      });

      expect(result.efficiency.staticAdditiveEfficiency).toBeCloseTo(0.6);
      expect(result.production.producedUnits).toBeCloseTo(16);
    });

    it("adds a facility-external synthetic remote effect independently", () => {
      const result = simulateFacilityProduction({
        durationHours: 12,
        facility: { kind: "factory", level: 3, product: "gold" },
        remoteEffects: [{ id: "control-room", source: "remote", additiveEfficiency: 0.15, target: "all" }]
      });

      expect(result.efficiency.remoteAdditiveEfficiency).toBe(0.15);
      expect(result.production.producedUnits).toBeCloseTo(11.5);
    });

    it("sums cancellation-prone effects deterministically by ID regardless of declaration order", () => {
      const effects = [
        operatorEffect("large-positive", 1e16),
        operatorEffect("large-negative", -1e16),
        operatorEffect("unit", 1)
      ];
      const permutations = [
        effects,
        [effects[0], effects[2], effects[1]],
        [effects[1], effects[0], effects[2]],
        [effects[1], effects[2], effects[0]],
        [effects[2], effects[0], effects[1]],
        [effects[2], effects[1], effects[0]]
      ];

      const results = permutations.map((teamEffects) => simulateFacilityProduction({
        durationHours: 1,
        facility: { kind: "factory", level: 3, product: "gold" },
        teamEffects
      }));

      expect(results.map((result) => result.efficiency.teamAdditiveEfficiency)).toEqual(Array(6).fill(1));
      expect(results.map((result) => result.production.producedUnits)).toEqual(Array(6).fill(5 / 3));
    });

    it("preserves ordinary cancellation without publishing negative zero", () => {
      const result = simulateFacilityProduction({
        durationHours: 1,
        facility: { kind: "factory", level: 3, product: "gold" },
        teamEffects: [operatorEffect("positive", 0.25), operatorEffect("negative", -0.25)]
      });

      expect(result.efficiency.teamAdditiveEfficiency).toBe(0);
      expect(Object.is(result.efficiency.teamAdditiveEfficiency, -0)).toBe(false);
      expect(result.production.producedUnits).toBeCloseTo(5 / 6);
    });

    it("rejects finite efficiency overflow before finite storage can hide it", () => {
      expect(() => simulateFacilityProduction({
        durationHours: 1,
        facility: { kind: "factory", level: 3, product: "gold" },
        teamEffects: [
          operatorEffect("max-a", Number.MAX_VALUE),
          operatorEffect("max-b", Number.MAX_VALUE)
        ],
        storage: { initialUnits: 0, capacityUnits: 1 }
      })).toThrow(/teamAdditiveEfficiency must be a finite number/);
    });
  });

  describe("active efficiency effect profiles", () => {
    it.each([
      [
        "within team effects",
        {
          teamEffects: [operatorEffect("duplicate-team", 0.1), operatorEffect("duplicate-team", 0.2)]
        },
        /duplicate effect ID "duplicate-team".*teamEffects\[1\].*teamEffects\[0\]/
      ],
      [
        "within remote effects",
        {
          remoteEffects: [
            { id: "duplicate-remote", source: "remote" as const, additiveEfficiency: 0.1, target: "all" as const },
            { id: "duplicate-remote", source: "remote" as const, additiveEfficiency: 0.2, target: "all" as const }
          ]
        },
        /duplicate effect ID "duplicate-remote".*remoteEffects\[1\].*remoteEffects\[0\]/
      ],
      [
        "between team and remote effects",
        {
          teamEffects: [operatorEffect("duplicate-static", 0.1)],
          remoteEffects: [
            { id: "duplicate-static", source: "remote" as const, additiveEfficiency: 0.2, target: "all" as const }
          ]
        },
        /duplicate effect ID "duplicate-static".*remoteEffects\[0\].*teamEffects\[0\]/
      ],
      [
        "within one event",
        {
          efficiencyEvents: [{
            atHour: 1,
            effects: [operatorEffect("duplicate-event", 0.1), operatorEffect("duplicate-event", 0.2)]
          }]
        },
        /duplicate effect ID "duplicate-event".*efficiencyEvents\[0\]\.effects\[1\].*efficiencyEvents\[0\]\.effects\[0\]/
      ],
      [
        "between static and event effects",
        {
          remoteEffects: [
            { id: "duplicate-active", source: "remote" as const, additiveEfficiency: 0.1, target: "all" as const }
          ],
          efficiencyEvents: [{ atHour: 1, effects: [operatorEffect("duplicate-active", 0.2)] }]
        },
        /duplicate effect ID "duplicate-active".*efficiencyEvents\[0\]\.effects\[0\].*remoteEffects\[0\]/
      ]
    ])("rejects duplicate IDs %s instead of double-counting them", (_label, partial, diagnostic) => {
      expect(() => simulateFacilityProduction({
        durationHours: 2,
        facility: { kind: "factory", level: 3, product: "gold" },
        ...partial
      })).toThrow(diagnostic);
    });

    it.each([
      [
        "team operator effect",
        { teamEffects: [{ id: "wrong-team-source", source: "remote" as const, additiveEfficiency: 0.1, target: "all" as const }] },
        /teamEffects\[0\]\.source.*operator/
      ],
      [
        "remote external effect",
        { remoteEffects: [operatorEffect("wrong-remote-source", 0.1)] },
        /remoteEffects\[0\]\.source.*remote/
      ]
    ])("rejects a wrong source for a %s", (_label, partial, diagnostic) => {
      expect(() => simulateFacilityProduction({
        durationHours: 2,
        facility: { kind: "factory", level: 3, product: "gold" },
        ...partial
      })).toThrow(diagnostic);
    });

    it("allows distinct static effects and ID reuse across replacement events without mutating input", () => {
      const input = {
        durationHours: 3,
        facility: { kind: "factory" as const, level: 3 as const, product: "gold" as const },
        teamEffects: [operatorEffect("team", 0.1)],
        remoteEffects: [
          { id: "remote", source: "remote" as const, additiveEfficiency: 0.2, target: "all" as const }
        ],
        efficiencyEvents: [
          {
            atHour: 1,
            effects: [
              operatorEffect("replacement", 0.4),
              { id: "event-remote", source: "remote" as const, additiveEfficiency: 0.05, target: "all" as const }
            ]
          },
          {
            atHour: 2,
            effects: [
              { id: "replacement", source: "remote" as const, additiveEfficiency: 0.6, target: "all" as const }
            ]
          }
        ]
      };
      const snapshot = structuredClone(input);

      const result = simulateFacilityProduction(input);

      expect(result.efficiency).toEqual({
        staticAdditiveEfficiency: 0.30000000000000004,
        teamAdditiveEfficiency: 0.1,
        remoteAdditiveEfficiency: 0.2
      });
      expect(result.segments.map((segment) => segment.additiveEfficiency)).toEqual([
        0.30000000000000004,
        0.75,
        0.9
      ]);
      expect(result.production.producedUnits).toBeCloseTo((60 / 72) * (1.3 + 1.75 + 1.9));
      expect(input).toEqual(snapshot);
    });
  });

  it("applies product-specific effects only to their target factory product", () => {
    const effects: ProductionEfficiencyEffect[] = [
      operatorEffect("gold-only", 0.5, "gold"),
      operatorEffect("records-only", 0.25, "battleRecord")
    ];

    const gold = simulateFacilityProduction({
      durationHours: 12,
      facility: { kind: "factory", level: 3, product: "gold" },
      teamEffects: effects
    });
    const records = simulateFacilityProduction({
      durationHours: 12,
      facility: { kind: "factory", level: 3, product: "battleRecord" },
      teamEffects: effects
    });

    expect(gold.efficiency.staticAdditiveEfficiency).toBe(0.5);
    expect(gold.production.producedUnits).toBeCloseTo(15);
    expect(records.efficiency.staticAdditiveEfficiency).toBe(0.25);
    expect(records.production.producedUnits).toBeCloseTo(5);
  });

  describe("continuous time and event boundaries", () => {
    it("evaluates a fractional-hour morale threshold as piecewise-constant segments", () => {
      const result = simulateFacilityProduction({
        durationHours: 2,
        facility: { kind: "factory", level: 3, product: "gold" },
        efficiencyEvents: [{
          atHour: 1.25,
          label: "fractional morale threshold",
          effects: [operatorEffect("after-threshold", 1)]
        }]
      });

      expect(result.segments.map(({ startHour, endHour, efficiencyMultiplier }) => ({
        startHour,
        endHour,
        efficiencyMultiplier
      }))).toEqual([
        { startHour: 0, endHour: 1.25, efficiencyMultiplier: 1 },
        { startHour: 1.25, endHour: 2, efficiencyMultiplier: 2 }
      ]);
      expect(result.production.producedUnits).toBeCloseTo(1.25 * (60 / 72) + 0.75 * (120 / 72));
    });

    it("preserves an arbitrary positive fractional duration without integer-hour truncation", () => {
      const result = simulateFacilityProduction({
        durationHours: 2.5,
        facility: { kind: "factory", level: 3, product: "gold" }
      });

      expect(result.durationHours).toBe(2.5);
      expect(result.production.producedUnits).toBeCloseTo(2.5 * 60 / 72);
    });

    it.each([
      ["zero duration", { durationHours: 0 }],
      ["negative duration", { durationHours: -1 }],
      ["non-finite duration", { durationHours: Number.POSITIVE_INFINITY }],
      ["NaN efficiency", { durationHours: 12, teamEffects: [operatorEffect("bad", Number.NaN)] }],
      ["unsorted boundaries", { durationHours: 12, efficiencyEvents: [{ atHour: 5, effects: [] }, { atHour: 4, effects: [] }] }],
      ["boundary at start", { durationHours: 12, efficiencyEvents: [{ atHour: 0, effects: [] }] }],
      ["boundary at end", { durationHours: 12, efficiencyEvents: [{ atHour: 12, effects: [] }] }]
    ])("rejects %s", (_label, partial) => {
      expect(() => simulateFacilityProduction({
        facility: { kind: "factory", level: 3, product: "gold" },
        ...partial
      })).toThrow(/durationHours|efficiency|boundar/i);
    });
  });

  it("reports continuous production blocked by explicit storage capacity", () => {
    const result = simulateFacilityProduction({
      durationHours: 12,
      facility: { kind: "factory", level: 3, product: "gold" },
      storage: { initialUnits: 2, capacityUnits: 7 }
    });

    expect(result.production.potentialUnits).toBeCloseTo(10);
    expect(result.production.producedUnits).toBeCloseTo(5);
    expect(result.storage).toEqual({
      initialUnits: 2,
      capacityUnits: 7,
      remainingCapacityUnits: 0,
      blockedTimeHours: 6
    });
    expect(result.ledger.natural.goldProduced).toBeCloseTo(5);
  });

  it("keeps display rounding separate from the deterministic continuous internal value", () => {
    const result = simulateFacilityProduction({
      durationHours: 4,
      facility: { kind: "factory", level: 3, product: "gold" },
      display: { decimalPlaces: 2 }
    });

    expect(result.production.producedUnits).toBeCloseTo(10 / 3);
    expect(result.display).toEqual({ decimalPlaces: 2, producedUnits: 3.33 });
  });

  it("keeps display rounding finite when decimal scaling would overflow", () => {
    const result = simulateFacilityProduction({
      durationHours: 1e308,
      facility: { kind: "factory", level: 3, product: "gold" },
      display: { decimalPlaces: 12 }
    });

    expect(result.production.producedUnits).toBe(8.333333333333334e307);
    expect(result.display).toEqual({
      decimalPlaces: 12,
      producedUnits: 8.333333333333334e307
    });
    expect(Number.isFinite(result.display?.producedUnits)).toBe(true);
  });

  it("retains ordinary display rounding behavior", () => {
    const result = simulateFacilityProduction({
      durationHours: 1.206,
      facility: { kind: "factory", level: 3, product: "gold" },
      display: { decimalPlaces: 2 }
    });

    expect(result.production.producedUnits).toBeCloseTo(1.005);
    expect(result.display).toEqual({ decimalPlaces: 2, producedUnits: 1.01 });
  });
});
