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
  specialOrders?: readonly FixedDroneSpecialOrderProfile[]
) => ({ targetFacilityId, drones, orderAcquisitionEfficiency, specialOrders });

describe("24-hour level-3 trading-post drone allocation", () => {
  it("caps end inventory and reports completed recovery lost after aggregate allocation", () => {
    const result = simulateTradingPostDrones24h({
      initialDrones: 100,
      powerPlantSkillIncrements: [
        { id: "power-a", recoveryRateIncrement: 0.1 },
        { id: "power-b", recoveryRateIncrement: 0.2 }
      ],
      allocations: [allocation("trading-1", 100)]
    });

    expect(result.generation).toEqual({
      baseRatePerHour: 10,
      baseGenerated: 240,
      skillIncrements: [
        { id: "power-a", recoveryRateIncrement: 0.1, generatedDrones: 24 },
        { id: "power-b", recoveryRateIncrement: 0.2, generatedDrones: 48 }
      ],
      skillGenerated: 72,
      continuousGenerated: 312,
      completedRecovery: 312,
      uncompletedDroneProgress: 0
    });
    expect(result.inventory).toEqual({
      cap: 235,
      initial: 100,
      maximumPotentiallyUsable: 412,
      used: 100,
      remaining: 235,
      overflow: 77
    });
    expect(result.inventory.remaining).toBeLessThanOrEqual(result.inventory.cap);
    expect(result.semantics).toEqual({
      allocationTimingAssumption: "just-in-time-consumption",
      capOverflowAccounting: "after-aggregate-allocation",
      exactScheduleFeasibility: "not-evaluated"
    });
    // Raw completed recovery is retained even when some recovered drones overflow the inventory cap.
    expect(result.ledger).toMatchObject({ dronesGenerated: 312, dronesUsed: 100 });
  });

  it("keeps fractional recovery progress while exposing only whole generated drones as available", () => {
    const result = simulateTradingPostDrones24h({
      initialDrones: 0,
      powerPlantSkillIncrements: [{ id: "fractional-progress", recoveryRateIncrement: 0.001 }],
      allocations: [allocation("trading-1", 240)]
    });

    expect(result.generation.skillGenerated).toBeCloseTo(0.24);
    expect(result.generation.continuousGenerated).toBeCloseTo(240.24);
    expect(result.generation.completedRecovery).toBe(240);
    expect(result.generation.uncompletedDroneProgress).toBeCloseTo(0.24);
    expect(result.inventory).toMatchObject({
      maximumPotentiallyUsable: 240,
      used: 240,
      remaining: 0,
      overflow: 0
    });
  });

  it("has no overflow when high aggregate usage consumes recovery before the cap binds", () => {
    const result = simulateTradingPostDrones24h({
      initialDrones: 100,
      powerPlantSkillIncrements: [
        { id: "power-a", recoveryRateIncrement: 0.1 },
        { id: "power-b", recoveryRateIncrement: 0.2 }
      ],
      allocations: [allocation("trading-1", 300)]
    });

    expect(result.inventory).toMatchObject({
      cap: 235,
      maximumPotentiallyUsable: 412,
      used: 300,
      remaining: 112,
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
    const naturalOrders = (1440 / 203.4) * 1.5;
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
    ["fractional initial inventory", { initialDrones: 1.5 }, /initialDrones.*integer/i],
    ["duplicate targets", { allocations: [allocation("trading-1", 1), allocation("trading-1", 2)] }, /duplicate.*trading-1/i],
    ["negative allocation", { allocations: [allocation("trading-1", -1)] }, /drones.*non-negative integer/i],
    ["fractional allocation", { allocations: [allocation("trading-1", 1.5)] }, /drones.*non-negative integer/i],
    ["non-finite allocation", { allocations: [allocation("trading-1", Number.POSITIVE_INFINITY)] }, /drones.*non-negative integer/i],
    ["non-finite skill increment", { powerPlantSkillIncrements: [{ id: "bad", recoveryRateIncrement: Number.NaN }] }, /recoveryRateIncrement.*finite non-negative/i],
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
    })).toThrow(/used 241.*available 240/i);
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

  it("does not mutate inputs and freezes the calculation result", () => {
    const input: TradingPostDroneSimulationInput = {
      initialDrones: 5,
      powerPlantSkillIncrements: [{ id: "power", recoveryRateIncrement: 0.15 }],
      allocations: [allocation("trading-1", 5, 0.25)],
      baseContext: createMaxLevel243BenchmarkContext()
    };
    const before = structuredClone(input);

    const result = simulateTradingPostDrones24h(input);

    expect(input).toEqual(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.targets)).toBe(true);
    expect(Object.isFrozen(result.targets[0].ledger.drone)).toBe(true);
  });
});
