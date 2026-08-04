import { describe, expect, it } from "vitest";
import {
  aggregateResourceLedgers,
  createResourceLedger,
  type ResourceLedger,
  type ResourceLedgerInput
} from "./resourceLedger";

describe("resource ledger", () => {
  it("derives totals and net gold while separating natural and drone contributions", () => {
    const input = {
      natural: { goldProduced: 12, goldConsumed: 4, battleRecordExp: 1000, lmd: 2000 },
      drone: { goldConsumed: 3, lmd: 1500 },
      dronesGenerated: 240,
      dronesUsed: 200
    };
    const before = structuredClone(input);

    const ledger = createResourceLedger(input);

    expect(ledger).toMatchObject({
      goldProduced: 12,
      goldConsumed: 7,
      goldNetChange: 5,
      battleRecordExp: 1000,
      lmd: 3500,
      natural: { goldProduced: 12, goldConsumed: 4, battleRecordExp: 1000, lmd: 2000 },
      drone: { goldProduced: 0, goldConsumed: 3, battleRecordExp: 0, lmd: 1500 },
      dronesGenerated: 240,
      dronesUsed: 200
    });
    expect(input).toEqual(before);
  });

  it("derives totals instead of trusting caller-supplied aggregate values", () => {
    const input = {
      natural: { goldProduced: 8, goldConsumed: 3 },
      goldProduced: 999,
      goldConsumed: 0,
      goldNetChange: 999
    } as ResourceLedgerInput;

    expect(createResourceLedger(input)).toMatchObject({
      goldProduced: 8,
      goldConsumed: 3,
      goldNetChange: 5
    });
  });

  it("aggregates ledgers without mutating either the ledgers or the input array", () => {
    const first = createResourceLedger({ natural: { goldProduced: 10, lmd: 100 }, dronesGenerated: 20 });
    const second = createResourceLedger({ drone: { goldConsumed: 3, lmd: 50 }, dronesUsed: 10 });
    const inputs = [first, second];
    const before = structuredClone(inputs);

    const total = aggregateResourceLedgers(inputs);

    expect(total).toMatchObject({ goldProduced: 10, goldConsumed: 3, goldNetChange: 7, lmd: 150 });
    expect(total.natural).not.toBe(first.natural);
    expect(inputs).toEqual(before);
  });

  it.each([
    ["negative natural flow", { natural: { goldProduced: -1 } }],
    ["infinite drone flow", { drone: { lmd: Number.POSITIVE_INFINITY } }],
    ["NaN drone count", { dronesUsed: Number.NaN }]
  ])("rejects %s", (_label, input) => {
    expect(() => createResourceLedger(input)).toThrow(/finite non-negative number/);
  });

  it("rejects an invalid primitive flow in a ledger passed to aggregation", () => {
    const malformed = {
      ...createResourceLedger(),
      natural: { goldProduced: -1, goldConsumed: 0, battleRecordExp: 0, lmd: 0 }
    } as ResourceLedger;

    expect(() => aggregateResourceLedgers([malformed])).toThrow(/finite non-negative number/);
  });
});
