import { describe, expect, it } from "vitest";
import { createMaxLevel243BenchmarkContext } from "./benchmarkBaseContext";
import {
  simulateTradingPostDrones24h,
  type FixedDroneSpecialOrderProfile,
  type TradingPostDroneSimulationInput
} from "./tradingPostDrones";

const allocation = (
  targetFacilityId: string,
  drones: number,
  orderAcquisitionEfficiency = 0,
  specialOrders?: readonly FixedDroneSpecialOrderProfile[],
  slot: 0 | 1 = 0
) => ({ targetFacilityId, drones, orderAcquisitionEfficiency, specialOrders, slot });

describe("24-hour level-3 trading-post drone allocation", () => {
  it("does not let future-slot recovery fund the first slot", () => {
    expect(() => simulateTradingPostDrones24h({
      initialDrones: 0,
      powerPlantSkillIncrements: [],
      allocations: [allocation("trading-1", 121)]
    })).toThrow(/slot 0.*used 121.*available 120/i);
  });

  it("loses cap overflow before a later-slot spend", () => {
    const result = simulateTradingPostDrones24h({
      initialDrones: 235,
      powerPlantSkillIncrements: [],
      allocations: [allocation("trading-1", 235, 0, undefined, 1)]
    });

    expect(result.inventory.timeline).toEqual([
      { slot: 0, startHour: 0, endHour: 12, opening: 235, generated: 120, overflow: 120, available: 235, used: 0, ending: 235 },
      { slot: 1, startHour: 12, endHour: 24, opening: 235, generated: 120, overflow: 120, available: 235, used: 235, ending: 0 }
    ]);
    expect(result.inventory).toMatchObject({ generated: 240, used: 235, remaining: 0, overflow: 240 });
  });

  it("retains fractional generated and used expected quantities", () => {
    const result = simulateTradingPostDrones24h({
      initialDrones: 0,
      powerPlantSkillIncrements: [
        { slot: 0, sourceFacilityId: "power-1", id: "fractional-progress", recoveryRateIncrement: 0.001 },
        { slot: 1, sourceFacilityId: "power-1", id: "fractional-progress", recoveryRateIncrement: 0.001 }
      ],
      allocations: [
        allocation("trading-1", 120.12),
        allocation("trading-1", 120.12, 0, undefined, 1)
      ]
    });

    for (const slot of result.inventory.timeline) {
      expect(slot.generated).toBeCloseTo(120.12);
      expect(slot.used).toBeCloseTo(120.12);
      expect(slot.ending).toBe(0);
    }
    expect(result.ledger.dronesGenerated).toBeCloseTo(240.24);
    expect(result.ledger.dronesUsed).toBeCloseTo(240.24);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].drones).toBeCloseTo(240.24);
    expect(result.targets[0].ledger.natural.lmd).toBeCloseTo((1440 / 203.4) * 1450);
  });

  it("uses each slot's power-plant profile for its own continuous generated batch", () => {
    const result = simulateTradingPostDrones24h({
      initialDrones: 0,
      powerPlantSkillIncrements: [
        { slot: 0, sourceFacilityId: "power-1", id: "wikiru-drone-skill", recoveryRateIncrement: 0.63 },
        { slot: 1, sourceFacilityId: "power-1", id: "wikiru-drone-skill", recoveryRateIncrement: 0.60 }
      ],
      allocations: [
        allocation("trading-1", 195.6, 0, undefined, 0),
        allocation("trading-1", 192, 0, undefined, 1)
      ]
    });

    expect(result.generation.slots).toEqual([
      { slot: 0, baseGenerated: 120, skillGenerated: 75.6, generated: 195.6 },
      { slot: 1, baseGenerated: 120, skillGenerated: 72, generated: 192 }
    ]);
    expect(result.inventory.timeline.map(({ slot, generated, used, ending }) => ({ slot, generated, used, ending }))).toEqual([
      { slot: 0, generated: 195.6, used: 195.6, ending: 0 },
      { slot: 1, generated: 192, used: 192, ending: 0 }
    ]);
    expect(result.ledger).toMatchObject({ dronesGenerated: 387.6, dronesUsed: 387.6 });
  });

  it("aggregates distinct profiles for two slots of the same target exactly once", () => {
    const exclusive = {
      id: "slot-0-exclusive",
      behavior: "exclusive",
      gold: 4,
      lmd: 2500,
      baseMinutes: 60,
      affectedByEfficiency: true
    } as const;
    const additive = {
      id: "slot-1-additive",
      behavior: "additive",
      gold: 1,
      lmd: 250,
      baseMinutes: 60,
      affectedByEfficiency: false
    } as const;
    const result = simulateTradingPostDrones24h({
      initialDrones: 0,
      powerPlantSkillIncrements: [],
      allocations: [
        allocation("trading-1", 10, 0.5, [exclusive], 0),
        allocation("trading-1", 20, 0.25, [additive], 1)
      ]
    });
    const target = result.targets[0];
    const slot0NaturalOrders = (720 / 203.4) * 1.5;
    const slot1NaturalOrders = (720 / 203.4) * 1.25;

    expect(target).not.toHaveProperty("orderAcquisitionEfficiency");
    expect(target).not.toHaveProperty("specialOrder");
    expect(target.slots.map((slot) => ({
      slot: slot.slot,
      drones: slot.drones,
      efficiency: slot.orderAcquisitionEfficiency,
      specialOrder: slot.specialOrder,
      droneOrders: slot.droneOrders,
      shortenedMinutes: slot.shortenedMinutes
    }))).toEqual([
      {
        slot: 0,
        drones: 10,
        efficiency: 0.5,
        specialOrder: exclusive,
        droneOrders: { normal: 0, special: 0.75 },
        shortenedMinutes: 30
      },
      {
        slot: 1,
        drones: 20,
        efficiency: 0.25,
        specialOrder: additive,
        droneOrders: { normal: (60 / 203.4) * 1.25, special: 1 },
        shortenedMinutes: 60
      }
    ]);
    expect(target.slots[0].naturalOrders).toBeCloseTo(slot0NaturalOrders);
    expect(target.slots[1].naturalOrders).toBeCloseTo(slot1NaturalOrders);
    expect(target.drones).toBe(target.slots.reduce((total, slot) => total + slot.drones, 0));
    expect(target.shortenedMinutes).toBe(target.slots.reduce((total, slot) => total + slot.shortenedMinutes, 0));
    expect(target.equivalentExtraProductiveTimeMinutes).toBe(
      target.slots.reduce((total, slot) => total + slot.equivalentExtraProductiveTimeMinutes, 0)
    );
    expect(target.naturalOrders).toBeCloseTo(target.slots.reduce((total, slot) => total + slot.naturalOrders, 0));
    expect(target.droneOrders.normal).toBeCloseTo(
      target.slots.reduce((total, slot) => total + slot.droneOrders.normal, 0)
    );
    expect(target.droneOrders.special).toBeCloseTo(
      target.slots.reduce((total, slot) => total + slot.droneOrders.special, 0)
    );
    expect(target.ledger.natural.lmd).toBeCloseTo((slot0NaturalOrders + slot1NaturalOrders) * 1450);
    expect(target.ledger.natural.lmd).not.toBeCloseTo((1440 / 203.4) * 1.5 * 1450);
    expect(target.ledger.natural.lmd).not.toBeCloseTo((slot0NaturalOrders + slot1NaturalOrders) * 2 * 1450);
    expect(target.ledger.drone.lmd).toBeCloseTo(0.75 * 2500 + ((60 / 203.4) * 1.25) * 1450 + 250);
    expect(result.ledger.natural).toEqual(target.ledger.natural);
    expect(result.ledger.drone).toEqual(target.ledger.drone);
  });

  it("represents a zero-drone target slot with only that slot's 12-hour natural production", () => {
    const target = simulateTradingPostDrones24h({
      initialDrones: 0,
      powerPlantSkillIncrements: [],
      allocations: [allocation("trading-1", 0, 0.2, undefined, 1)]
    }).targets[0];
    const naturalOrders = (720 / 203.4) * 1.2;

    expect(target.slots).toHaveLength(1);
    expect(target.slots[0]).toMatchObject({ slot: 1, drones: 0, naturalOrders, shortenedMinutes: 0 });
    expect(target.slots[0].ledger.natural.lmd).toBeCloseTo(naturalOrders * 1450);
    expect(target.ledger.natural).toEqual(target.slots[0].ledger.natural);
    expect(target.ledger.drone).toEqual(target.slots[0].ledger.drone);
  });

  it("caps inventory before each allocation and aggregates slot overflow", () => {
    const result = simulateTradingPostDrones24h({
      initialDrones: 100,
      powerPlantSkillIncrements: [
        { slot: 0, sourceFacilityId: "power-1", id: "power-a", recoveryRateIncrement: 0.1 },
        { slot: 0, sourceFacilityId: "power-2", id: "power-b", recoveryRateIncrement: 0.2 },
        { slot: 1, sourceFacilityId: "power-1", id: "power-a", recoveryRateIncrement: 0.1 },
        { slot: 1, sourceFacilityId: "power-2", id: "power-b", recoveryRateIncrement: 0.2 }
      ],
      allocations: [allocation("trading-1", 100)]
    });

    expect(result.generation).toEqual({
      baseRatePerHour: 10,
      baseGeneratedPerSlot: 120,
      baseGenerated: 240,
      skillIncrements: [
        { slot: 0, sourceFacilityId: "power-1", id: "power-a", recoveryRateIncrement: 0.1, generatedDrones: 12 },
        { slot: 0, sourceFacilityId: "power-2", id: "power-b", recoveryRateIncrement: 0.2, generatedDrones: 24 },
        { slot: 1, sourceFacilityId: "power-1", id: "power-a", recoveryRateIncrement: 0.1, generatedDrones: 12 },
        { slot: 1, sourceFacilityId: "power-2", id: "power-b", recoveryRateIncrement: 0.2, generatedDrones: 24 }
      ],
      skillGenerated: 72,
      continuousGenerated: 312,
      slots: [
        { slot: 0, baseGenerated: 120, skillGenerated: 36, generated: 156 },
        { slot: 1, baseGenerated: 120, skillGenerated: 36, generated: 156 }
      ]
    });
    expect(result.inventory).toEqual({
      cap: 235,
      initial: 100,
      generated: 312,
      used: 100,
      remaining: 235,
      overflow: 77,
      timeline: [
        { slot: 0, startHour: 0, endHour: 12, opening: 100, generated: 156, overflow: 21, available: 235, used: 100, ending: 135 },
        { slot: 1, startHour: 12, endHour: 24, opening: 135, generated: 156, overflow: 56, available: 235, used: 0, ending: 235 }
      ]
    });
    expect(result.inventory.remaining).toBeLessThanOrEqual(result.inventory.cap);
    expect(result.semantics).toEqual({
      allocationTimingAssumption: "slot-batch-consumption",
      capOverflowAccounting: "before-slot-allocation",
      scheduleFeasibility: "evaluated-at-slot-boundaries"
    });
    // Continuous expected recovery is retained even when some recovered drones overflow the inventory cap.
    expect(result.ledger).toMatchObject({ dronesGenerated: 312, dronesUsed: 100 });
  });

  it("keeps fractional initial inventory and continuous recovery without flooring", () => {
    const result = simulateTradingPostDrones24h({
      initialDrones: 0.5,
      powerPlantSkillIncrements: [{ slot: 0, sourceFacilityId: "power-1", id: "fractional-progress", recoveryRateIncrement: 0.001 }],
      allocations: [allocation("trading-1", 120.12)]
    });

    expect(result.generation.skillGenerated).toBeCloseTo(0.12);
    expect(result.generation.continuousGenerated).toBeCloseTo(240.12);
    expect(result.inventory.initial).toBe(0.5);
    expect(result.inventory.generated).toBeCloseTo(240.12);
    expect(result.inventory.used).toBeCloseTo(120.12);
    expect(result.inventory.remaining).toBeCloseTo(120.5);
    expect(result.inventory.overflow).toBe(0);
  });

  it("has no overflow when each slot spends before the next slot generates", () => {
    const result = simulateTradingPostDrones24h({
      initialDrones: 0,
      powerPlantSkillIncrements: [
        { slot: 0, sourceFacilityId: "power-1", id: "power-a", recoveryRateIncrement: 0.1 },
        { slot: 0, sourceFacilityId: "power-2", id: "power-b", recoveryRateIncrement: 0.2 },
        { slot: 1, sourceFacilityId: "power-1", id: "power-a", recoveryRateIncrement: 0.1 },
        { slot: 1, sourceFacilityId: "power-2", id: "power-b", recoveryRateIncrement: 0.2 }
      ],
      allocations: [
        allocation("trading-1", 150),
        allocation("trading-1", 150, 0, undefined, 1)
      ]
    });

    expect(result.inventory).toMatchObject({
      cap: 235,
      generated: 312,
      used: 300,
      remaining: 12,
      overflow: 0
    });
  });

  it("uses exactly three minutes per drone and keeps natural and drone resources separate", () => {
    const result = simulateTradingPostDrones24h({
      initialDrones: 10,
      powerPlantSkillIncrements: [],
      allocations: [allocation("trading-1", 10, 0.5)]
    });
    const target = result.targets[0];
    const naturalOrders = (720 / 203.4) * 1.5;
    const droneOrders = (30 / 203.4) * 1.5;

    expect(target.shortenedMinutes).toBe(30);
    expect(target.equivalentExtraProductiveTimeMinutes).toBe(45);
    expect(target.droneOrders.normal).toBeCloseTo(droneOrders);
    expect(target.ledger.natural.goldConsumed).toBeCloseTo(naturalOrders * 2.9);
    expect(target.ledger.natural.lmd).toBeCloseTo(naturalOrders * 1450);
    expect(target.ledger.drone.goldConsumed).toBeCloseTo(droneOrders * 2.9);
    expect(target.ledger.drone.lmd).toBeCloseTo(droneOrders * 1450);
    expect(target.ledger.drone.goldProduced).toBe(0);
    expect(target.ledger.goldConsumed).toBeCloseTo((naturalOrders + droneOrders) * 2.9);
    expect(target.ledger.lmd).toBeCloseTo((naturalOrders + droneOrders) * 1450);
  });

  it("applies order-acquisition efficiency to accelerated normal production exactly once", () => {
    const target = simulateTradingPostDrones24h({
      initialDrones: 20,
      powerPlantSkillIncrements: [],
      allocations: [allocation("trading-1", 20, 1)]
    }).targets[0];

    expect(target.equivalentExtraProductiveTimeMinutes).toBe(120);
    expect(target.ledger.drone.lmd).toBeCloseTo((120 / 203.4) * 1450);
    expect(target.ledger.drone.lmd).not.toBeCloseTo((120 / 203.4) * 1450 * 2);
  });

  it("replaces normal accelerated orders with an exclusive fixed special order", () => {
    const profile = {
      id: "exclusive-order",
      behavior: "exclusive",
      gold: 4,
      lmd: 2500,
      baseMinutes: 60,
      affectedByEfficiency: true
    } as const;
    const target = simulateTradingPostDrones24h({
      initialDrones: 10,
      powerPlantSkillIncrements: [],
      allocations: [allocation("trading-1", 10, 1, [profile])]
    }).targets[0];

    expect(target.droneOrders).toEqual({ normal: 0, special: 1 });
    expect(target.equivalentExtraProductiveTimeMinutes).toBe(60);
    expect(target.ledger.drone).toEqual({
      goldProduced: 0,
      goldConsumed: 4,
      battleRecordExp: 0,
      lmd: 2500
    });
  });

  it("does not apply order efficiency to a fixed special order that opts out", () => {
    const profile = {
      id: "fixed-speed-order",
      behavior: "exclusive",
      gold: 2,
      lmd: 1500,
      baseMinutes: 60,
      affectedByEfficiency: false
    } as const;
    const target = simulateTradingPostDrones24h({
      initialDrones: 10,
      powerPlantSkillIncrements: [],
      allocations: [allocation("trading-1", 10, 1, [profile])]
    }).targets[0];

    expect(target.droneOrders).toEqual({ normal: 0, special: 0.5 });
    expect(target.equivalentExtraProductiveTimeMinutes).toBe(30);
    expect(target.ledger.drone.goldConsumed).toBe(1);
    expect(target.ledger.drone.lmd).toBe(750);
  });

  it("adds an additive fixed bonus without replacing normal accelerated gold cost", () => {
    const profile = {
      id: "additive-order",
      behavior: "additive",
      gold: 1,
      lmd: 250,
      baseMinutes: 60,
      affectedByEfficiency: false
    } as const;
    const target = simulateTradingPostDrones24h({
      initialDrones: 10,
      powerPlantSkillIncrements: [],
      allocations: [allocation("trading-1", 10, 1, [profile])]
    }).targets[0];
    const normalOrders = 60 / 203.4;

    expect(target.droneOrders.normal).toBeCloseTo(normalOrders);
    expect(target.droneOrders.special).toBe(0.5);
    expect(target.ledger.drone.goldConsumed).toBeCloseTo(normalOrders * 2.9 + 0.5);
    expect(target.ledger.drone.lmd).toBeCloseTo(normalOrders * 1450 + 125);
  });

  it.each([
    ["initial inventory over the verified cap", { initialDrones: 236 }, /initialDrones.*235/i],
    ["duplicate targets", { allocations: [allocation("trading-1", 1), allocation("trading-1", 2)] }, /duplicate.*trading-1/i],
    ["negative allocation", { allocations: [allocation("trading-1", -1)] }, /drones.*finite non-negative number/i],
    ["non-finite allocation", { allocations: [allocation("trading-1", Number.POSITIVE_INFINITY)] }, /drones.*finite non-negative number/i],
    ["invalid slot", { allocations: [{ ...allocation("trading-1", 1), slot: 2 as 0 }] }, /slot.*0 or 1/i],
    ["invalid skill slot", { powerPlantSkillIncrements: [{ slot: 2 as 0, sourceFacilityId: "power-1", id: "bad-slot", recoveryRateIncrement: 0 }] }, /slot.*0 or 1/i],
    ["missing power source", { powerPlantSkillIncrements: [{ slot: 0 as const, sourceFacilityId: undefined as unknown as string, id: "missing-source", recoveryRateIncrement: 0 }] }, /sourceFacilityId.*non-empty string/i],
    ["duplicate skill increment ID in a slot", { powerPlantSkillIncrements: [
      { slot: 0 as const, sourceFacilityId: "power-1", id: "duplicate", recoveryRateIncrement: 0.1 },
      { slot: 0 as const, sourceFacilityId: "power-2", id: "duplicate", recoveryRateIncrement: 0.2 }
    ] }, /duplicate.*increment.*slot 0.*duplicate/i],
    ["non-finite skill increment", { powerPlantSkillIncrements: [{ slot: 0 as const, sourceFacilityId: "power-1", id: "bad", recoveryRateIncrement: Number.NaN }] }, /recoveryRateIncrement.*finite non-negative/i],
    ["ambiguous special orders", {
      allocations: [allocation("trading-1", 1, 0, [
        { id: "exclusive", behavior: "exclusive", gold: 1, lmd: 500, baseMinutes: 60, affectedByEfficiency: true },
        { id: "additive", behavior: "additive", gold: 1, lmd: 100, baseMinutes: 60, affectedByEfficiency: true }
      ])]
    }, /specialOrders.*at most one/i],
    ["non-finite special-order value", {
      allocations: [allocation("trading-1", 1, 0, [
        { id: "bad", behavior: "exclusive", gold: 1, lmd: Number.NaN, baseMinutes: 60, affectedByEfficiency: true }
      ])]
    }, /specialOrders.*lmd.*finite non-negative/i]
  ])("rejects %s", (_label, patch, expected) => {
    const input: TradingPostDroneSimulationInput = {
      initialDrones: 0,
      powerPlantSkillIncrements: [],
      allocations: [allocation("trading-1", 0)],
      ...patch
    };

    expect(() => simulateTradingPostDrones24h(input)).toThrow(expected as RegExp);
  });

  it("rejects use above available drones", () => {
    expect(() => simulateTradingPostDrones24h({
      initialDrones: 0,
      powerPlantSkillIncrements: [],
      allocations: [allocation("trading-1", 241)]
    })).toThrow(/slot 0.*used 241.*available 120/i);
  });

  it.each([
    ["unknown facility", "missing-room", /unknown facility.*missing-room/i],
    ["non-trading facility", "factory-1", /factory-1.*not a trading/i]
  ])("rejects an allocation to an %s when a benchmark context is supplied", (_label, target, expected) => {
    expect(() => simulateTradingPostDrones24h({
      initialDrones: 0,
      powerPlantSkillIncrements: [],
      allocations: [allocation(target, 1)],
      baseContext: createMaxLevel243BenchmarkContext()
    })).toThrow(expected);
  });

  it("uses the canonical 243 context when baseContext is omitted", () => {
    expect(() => simulateTradingPostDrones24h({
      initialDrones: 0,
      powerPlantSkillIncrements: [],
      allocations: [allocation("missing-room", 1)]
    })).toThrow(/unknown facility.*missing-room/i);
  });

  it("rejects more power-source witnesses than the slot capacity permits", () => {
    expect(() => simulateTradingPostDrones24h({
      initialDrones: 0,
      powerPlantSkillIncrements: [
        { slot: 0, sourceFacilityId: "power-1", id: "source-1", recoveryRateIncrement: 0.1 },
        { slot: 0, sourceFacilityId: "power-2", id: "source-2", recoveryRateIncrement: 0.1 },
        { slot: 0, sourceFacilityId: "power-3", id: "source-3", recoveryRateIncrement: 0.1 },
        { slot: 0, sourceFacilityId: "power-1", id: "normalized-second-contribution", recoveryRateIncrement: 0.1 }
      ],
      allocations: []
    })).toThrow(/source facility.*power-1.*reused.*slot 0/i);
  });

  it.each([
    ["unknown", "missing-power", /unknown source facility.*missing-power/i],
    ["non-power", "factory-1", /factory-1.*not a power facility/i]
  ])("rejects an %s power-source facility", (_label, sourceFacilityId, expected) => {
    expect(() => simulateTradingPostDrones24h({
      initialDrones: 0,
      powerPlantSkillIncrements: [{ slot: 0, sourceFacilityId, id: "power", recoveryRateIncrement: 0.1 }],
      allocations: []
    })).toThrow(expected);
  });

  it("allows the same source facility and effect ID to recur in the other slot", () => {
    const result = simulateTradingPostDrones24h({
      initialDrones: 0,
      powerPlantSkillIncrements: [
        { slot: 0, sourceFacilityId: "power-1", id: "same-effect", recoveryRateIncrement: 0.1 },
        { slot: 1, sourceFacilityId: "power-1", id: "same-effect", recoveryRateIncrement: 0.1 }
      ],
      allocations: []
    });

    expect(result.generation.skillIncrements).toEqual([
      { slot: 0, sourceFacilityId: "power-1", id: "same-effect", recoveryRateIncrement: 0.1, generatedDrones: 12 },
      { slot: 1, sourceFacilityId: "power-1", id: "same-effect", recoveryRateIncrement: 0.1, generatedDrones: 12 }
    ]);
    expect(Object.isFrozen(result.generation.skillIncrements[0])).toBe(true);
  });

  it("does not mutate inputs and freezes the calculation result", () => {
    const input: TradingPostDroneSimulationInput = {
      initialDrones: 5,
      powerPlantSkillIncrements: [{ slot: 0, sourceFacilityId: "power-1", id: "power", recoveryRateIncrement: 0.15 }],
      allocations: [allocation("trading-1", 5, 0.25)],
      baseContext: createMaxLevel243BenchmarkContext()
    };
    const before = structuredClone(input);

    const result = simulateTradingPostDrones24h(input);

    expect(input).toEqual(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.targets)).toBe(true);
    expect(Object.isFrozen(result.targets[0].slots)).toBe(true);
    expect(Object.isFrozen(result.targets[0].slots[0])).toBe(true);
    expect(Object.isFrozen(result.targets[0].ledger.drone)).toBe(true);
  });
});
