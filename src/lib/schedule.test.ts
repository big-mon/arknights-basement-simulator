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

  it("normalizes ordering without deriving groups from shift count", () => {
    const schedule = normalizeSchedule({
      cycleHours: 36,
      groups: [{ id: "C" }, { id: "A" }, { id: "B" }],
      shifts: [
        { id: "third", startHour: 24, endHour: 36, activeGroupIds: ["C", "A"], recoveryGroupIds: ["B"] },
        { id: "first", startHour: 0, endHour: 12, activeGroupIds: ["A", "B"], recoveryGroupIds: ["C"] },
        { id: "second", startHour: 12, endHour: 24, activeGroupIds: ["B", "C"], recoveryGroupIds: ["A"] }
      ]
    });

    expect(schedule.groups.map((group) => group.id)).toEqual(["C", "A", "B"]);
    expect(schedule.shifts.map((shift) => shift.id)).toEqual(["first", "second", "third"]);
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
});
