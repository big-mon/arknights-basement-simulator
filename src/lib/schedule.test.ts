import { describe, expect, it } from "vitest";
import { defaultSchedule } from "../data/defaults";
import { normalizeSchedule, validateSchedule } from "./schedule";

describe("canonical schedule state", () => {
  it("defines the legacy-compatible 24h two-group 2x12 schedule exactly", () => {
    expect(defaultSchedule).toEqual({
      cycleHours: 24,
      groups: [{ id: "group-a" }, { id: "group-b" }],
      shifts: [
        { id: "shift-a", startHour: 0, endHour: 12, activeGroupIds: ["group-a"], recoveryGroupIds: ["group-b"] },
        { id: "shift-b", startHour: 12, endHour: 24, activeGroupIds: ["group-b"], recoveryGroupIds: ["group-a"] }
      ]
    });
  });

  it("canonicalizes every successful schedule surface without deriving groups from shift count", () => {
    const schedule = normalizeSchedule({
      cycleHours: 36,
      groups: [{ id: "C" }, { id: "A" }, { id: "B" }],
      shifts: [
        { id: "third", startHour: 24, endHour: 36, activeGroupIds: ["C", "A"], recoveryGroupIds: ["B"] },
        { id: "first", startHour: 0, endHour: 12, activeGroupIds: ["B", "A"], recoveryGroupIds: ["C"] },
        { id: "second", startHour: 12, endHour: 24, activeGroupIds: ["C", "B"], recoveryGroupIds: ["A"] }
      ]
    });

    expect(schedule).toEqual({
      cycleHours: 36,
      groups: [{ id: "A" }, { id: "B" }, { id: "C" }],
      shifts: [
        { id: "first", startHour: 0, endHour: 12, activeGroupIds: ["A", "B"], recoveryGroupIds: ["C"] },
        { id: "second", startHour: 12, endHour: 24, activeGroupIds: ["B", "C"], recoveryGroupIds: ["A"] },
        { id: "third", startHour: 24, endHour: 36, activeGroupIds: ["A", "C"], recoveryGroupIds: ["B"] }
      ]
    });
    expect(validateSchedule({
      cycleHours: 36,
      groups: [{ id: "C" }, { id: "A" }, { id: "B" }],
      shifts: [
        { id: "third", startHour: 24, endHour: 36, activeGroupIds: ["C", "A"], recoveryGroupIds: ["B"] },
        { id: "first", startHour: 0, endHour: 12, activeGroupIds: ["B", "A"], recoveryGroupIds: ["C"] },
        { id: "second", startHour: 12, endHour: 24, activeGroupIds: ["C", "B"], recoveryGroupIds: ["A"] }
      ]
    })).toEqual({ ok: true, value: schedule });
  });

  it("normalizes group, shift, and membership permutations to one deep-equal value", () => {
    const declared = {
      cycleHours: 24,
      groups: [{ id: "zeta" }, { id: "alpha" }, { id: "middle" }],
      shifts: [
        { id: "late", startHour: 16, endHour: 24, activeGroupIds: ["zeta", "middle"], recoveryGroupIds: ["alpha"] },
        { id: "early", startHour: 0, endHour: 8, activeGroupIds: ["zeta", "alpha"], recoveryGroupIds: ["middle"] },
        { id: "middle", startHour: 8, endHour: 16, activeGroupIds: ["middle", "alpha"], recoveryGroupIds: ["zeta"] }
      ]
    };
    const permuted = structuredClone(declared);
    permuted.groups.reverse();
    permuted.shifts.reverse();
    permuted.shifts.forEach((shift) => {
      shift.activeGroupIds.reverse();
      shift.recoveryGroupIds.reverse();
    });

    expect(normalizeSchedule(permuted)).toEqual(normalizeSchedule(declared));
  });

  it("accepts three distinct active groups without inventing recovery groups", () => {
    const schedule = normalizeSchedule({
      cycleHours: 24,
      groups: [{ id: "composition-1" }, { id: "composition-2" }, { id: "composition-3" }],
      shifts: [
        { id: "first", startHour: 0, endHour: 8, activeGroupIds: ["composition-1"], recoveryGroupIds: [] },
        { id: "second", startHour: 8, endHour: 16, activeGroupIds: ["composition-2"], recoveryGroupIds: [] },
        { id: "third", startHour: 16, endHour: 24, activeGroupIds: ["composition-3"], recoveryGroupIds: [] }
      ]
    });

    expect(schedule.shifts.map((shift) => shift.recoveryGroupIds)).toEqual([[], [], []]);
  });

  it.each([
    ["empty", { cycleHours: 24, groups: [], shifts: [] }],
    ["duplicate group", { cycleHours: 24, groups: [{ id: "A" }, { id: "A" }], shifts: [{ id: "s", startHour: 0, endHour: 24, activeGroupIds: ["A"], recoveryGroupIds: [] }] }],
    ["malformed ID", { cycleHours: 24, groups: [{ id: " bad " }], shifts: [{ id: "s", startHour: 0, endHour: 24, activeGroupIds: [" bad "], recoveryGroupIds: [] }] }],
    ["duplicate shift ID", { cycleHours: 24, groups: [{ id: "A" }], shifts: [{ id: "s", startHour: 0, endHour: 12, activeGroupIds: ["A"], recoveryGroupIds: [] }, { id: "s", startHour: 12, endHour: 24, activeGroupIds: ["A"], recoveryGroupIds: [] }] }],
    ["gap", { cycleHours: 24, groups: [{ id: "A" }], shifts: [{ id: "s", startHour: 1, endHour: 24, activeGroupIds: ["A"], recoveryGroupIds: [] }] }],
    ["overlap", { cycleHours: 24, groups: [{ id: "A" }], shifts: [{ id: "a", startHour: 0, endHour: 13, activeGroupIds: ["A"], recoveryGroupIds: [] }, { id: "b", startHour: 12, endHour: 24, activeGroupIds: ["A"], recoveryGroupIds: [] }] }],
    ["out of cycle", { cycleHours: 24, groups: [{ id: "A" }], shifts: [{ id: "s", startHour: 0, endHour: 25, activeGroupIds: ["A"], recoveryGroupIds: [] }] }],
    ["unknown group", { cycleHours: 24, groups: [{ id: "A" }], shifts: [{ id: "s", startHour: 0, endHour: 24, activeGroupIds: ["missing"], recoveryGroupIds: [] }] }]
  ])("rejects %s schedules deterministically", (_name, schedule) => {
    expect(validateSchedule(schedule).ok).toBe(false);
    expect(() => normalizeSchedule(schedule)).toThrowError(RangeError);
  });

  it("rejects each declared group that is never active without requiring recovery declarations", () => {
    const schedule = {
      cycleHours: 24,
      groups: [{ id: "active" }, { id: "unrepresented-b" }, { id: "unrepresented-c" }],
      shifts: [
        { id: "first", startHour: 0, endHour: 8, activeGroupIds: ["active"], recoveryGroupIds: [] },
        { id: "second", startHour: 8, endHour: 16, activeGroupIds: ["active"], recoveryGroupIds: [] },
        { id: "third", startHour: 16, endHour: 24, activeGroupIds: ["active"], recoveryGroupIds: [] }
      ]
    };

    expect(validateSchedule(schedule)).toEqual({
      ok: false,
      errors: [
        "group unrepresented-b must be active in at least one shift",
        "group unrepresented-c must be active in at least one shift"
      ]
    });
    expect(() => normalizeSchedule(schedule)).toThrowError(
      "invalid schedule: group unrepresented-b must be active in at least one shift; group unrepresented-c must be active in at least one shift"
    );
  });

  it("reports topology errors against caller declaration indexes before canonicalization", () => {
    expect(validateSchedule({
      cycleHours: 24,
      groups: [{ id: "A" }],
      shifts: [
        { id: "later", startHour: 13, endHour: 24, activeGroupIds: ["A"], recoveryGroupIds: [] },
        { id: "early", startHour: 0, endHour: 12, activeGroupIds: ["A"], recoveryGroupIds: [] }
      ]
    })).toEqual({
      ok: false,
      errors: ["shifts[0] creates a gap at hour 12"]
    });
  });
});
