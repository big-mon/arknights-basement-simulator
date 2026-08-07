import { describe, expect, it } from "vitest";
import {
  aggregateResourceLedgers,
  createResourceLedger,
  validateResourceLedger,
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

  it.each([
    ["natural primitive", { natural: 1 }],
    ["natural null", { natural: null }],
    ["natural array", { natural: [] }],
    ["drone primitive", { drone: "invalid" }],
    ["drone null", { drone: null }],
    ["drone array", { drone: [] }]
  ])("rejects a provided %s contribution object", (_label, input) => {
    expect(() => createResourceLedger(input as unknown as ResourceLedgerInput)).toThrow(/must be a non-null, non-array object/);
  });

  it("strict-validates complete ledgers without defaulting missing drone fields", () => {
    const missingGenerated = { ...createResourceLedger() } as Partial<ResourceLedger>;
    delete missingGenerated.dronesGenerated;
    const undefinedUsed = { ...createResourceLedger(), dronesUsed: undefined };

    expect(() => validateResourceLedger(missingGenerated, "authority")).toThrow(/authority\.dronesGenerated/);
    expect(() => validateResourceLedger(undefinedUsed, "authority")).toThrow(/authority\.dronesUsed/);
  });

  it.each([null, 1, "ledger", []])("rejects a non-object strict ledger authority value", (input) => {
    expect(() => validateResourceLedger(input, "authority")).toThrow(/authority must be a non-null, non-array object/);
  });

  it("requires complete fields to be own properties at the strict authority boundary", () => {
    const inherited = Object.create(createResourceLedger()) as ResourceLedger;

    expect(() => validateResourceLedger(inherited, "authority")).toThrow(/authority\.natural is required/);
  });

  it.each([
    ["goldProduced", { goldProduced: 1 }],
    ["goldConsumed", { goldConsumed: 1 }],
    ["battleRecordExp", { battleRecordExp: 1 }],
    ["lmd", { lmd: 1 }],
    ["goldNetChange", { goldNetChange: 1 }]
  ])("rejects an inconsistent top-level %s value", (_field, override) => {
    const forged = { ...createResourceLedger(), ...override };

    expect(() => validateResourceLedger(forged, "authority")).toThrow(/authority\..*inconsistent/);
  });

  it("rejects an invalid primitive flow in a ledger passed to aggregation", () => {
    const malformed = {
      ...createResourceLedger(),
      natural: { goldProduced: -1, goldConsumed: 0, battleRecordExp: 0, lmd: 0 }
    } as ResourceLedger;

    expect(() => aggregateResourceLedgers([malformed])).toThrow(/finite non-negative number/);
  });

  it("rejects a forged incomplete ledger passed to aggregation", () => {
    const incomplete = {
      ...createResourceLedger(),
      natural: { goldProduced: 1 },
      goldProduced: 1,
      goldNetChange: 1
    } as unknown as ResourceLedger;

    expect(() => aggregateResourceLedgers([incomplete])).toThrow(/ledgers\[0\]\.natural\.goldConsumed/);
  });

  it("rejects finite inputs whose aggregate addition overflows", () => {
    const large = createResourceLedger({ natural: { lmd: Number.MAX_VALUE } });

    expect(() => aggregateResourceLedgers([large, large])).toThrow(/lmd must be a finite non-negative number/);
  });
});
