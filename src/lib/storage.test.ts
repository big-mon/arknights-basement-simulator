import { beforeEach, describe, expect, it } from "vitest";
import { createDefaultState, createFacilitiesForLayout } from "../data/defaults";
import { normalizeSchedule } from "./schedule";
import { exportState, importState, loadState, saveState } from "./storage";

describe("AppState benchmark region persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("defaults new Japanese-first state to the JP benchmark boundary", () => {
    expect(createDefaultState().region).toBe("JP");
  });

  it("migrates legacy state without a region to JP without losing user configuration", () => {
    const legacyState = createDefaultState();
    legacyState.language = "en";
    legacyState.layout = "153";
    legacyState.facilities = createFacilitiesForLayout("153", legacyState.facilities);
    legacyState.preference = { gold: 0.7, battleRecord: 0.15, lmd: 0.15 };
    legacyState.roster.char_002_amiya.owned = true;
    const legacy = legacyState as unknown as Record<string, unknown>;
    delete legacy.region;

    const restored = importState(JSON.stringify({ version: 1, state: legacy }));

    expect(restored.region).toBe("JP");
    expect(restored.language).toBe("en");
    expect(restored.layout).toBe("153");
    expect(restored.facilities).toHaveLength(11);
    expect(restored.preference).toEqual({ gold: 0.7, battleRecord: 0.15, lmd: 0.15 });
    expect(restored.roster.char_002_amiya.owned).toBe(true);
  });

  it("round-trips an explicit CN region through export and import", () => {
    const state = createDefaultState();
    state.region = "CN";

    expect(importState(exportState(state)).region).toBe("CN");
  });

  it("serializes and reloads an explicit region in browser storage", () => {
    const state = createDefaultState();
    state.region = "CN";

    saveState(state);

    expect(JSON.parse(window.localStorage.getItem("arknights-basement-state-v1")!).region).toBe("CN");
    expect(loadState().region).toBe("CN");
  });

  it("normalizes an invalid region to the deterministic JP default", () => {
    const state = createDefaultState();
    const payload = JSON.parse(exportState(state));
    payload.state.region = "KR";

    expect(importState(JSON.stringify(payload)).region).toBe("JP");
  });

  it("migrates a legacy rotationCount-only state to the exact default schedule", () => {
    const legacy = createDefaultState() as unknown as Record<string, unknown>;
    delete legacy.schedule;
    legacy.rotationCount = 2;

    expect(importState(JSON.stringify({ version: 1, state: legacy })).schedule).toEqual(createDefaultState().schedule);
  });

  it("round-trips a current three-group 36-hour schedule without data loss", () => {
    const state = createDefaultState();
    state.schedule = {
      cycleHours: 36,
      groups: [{ id: "A" }, { id: "B" }, { id: "C" }],
      shifts: [
        { id: "ab", startHour: 0, endHour: 12, activeGroupIds: ["A", "B"], recoveryGroupIds: ["C"] },
        { id: "bc", startHour: 12, endHour: 24, activeGroupIds: ["B", "C"], recoveryGroupIds: ["A"] },
        { id: "ca", startHour: 24, endHour: 36, activeGroupIds: ["C", "A"], recoveryGroupIds: ["B"] }
      ]
    };

    expect(importState(exportState(state)).schedule).toEqual(normalizeSchedule(state.schedule));
  });

  it("falls back only malformed stored or imported schedules while preserving valid user data", () => {
    const state = createDefaultState();
    state.language = "en";
    state.region = "CN";
    state.layout = "153";
    state.facilities = createFacilitiesForLayout("153", state.facilities);
    state.preference = { gold: 0.7, battleRecord: 0.2, lmd: 0.1 };
    state.roster.char_002_amiya.owned = true;
    const stored = state as unknown as Record<string, unknown>;
    stored.schedule = { cycleHours: 24, groups: [{ id: "A" }], shifts: [] };
    window.localStorage.setItem("arknights-basement-state-v1", JSON.stringify(stored));

    const restoredStates = [
      loadState(),
      importState(JSON.stringify({ version: 1, state: stored }))
    ];

    for (const restored of restoredStates) {
      expect(restored.schedule).toEqual(createDefaultState().schedule);
      expect(restored.schedule).not.toBe(createDefaultState().schedule);
      expect(restored.language).toBe("en");
      expect(restored.region).toBe("CN");
      expect(restored.layout).toBe("153");
      expect(restored.facilities).toHaveLength(11);
      expect(restored.preference).toEqual({ gold: 0.7, battleRecord: 0.2, lmd: 0.1 });
      expect(restored.roster.char_002_amiya.owned).toBe(true);
    }
  });
});
