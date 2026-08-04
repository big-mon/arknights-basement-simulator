import { beforeEach, describe, expect, it } from "vitest";
import { createDefaultState, createFacilitiesForLayout } from "../data/defaults";
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
});
