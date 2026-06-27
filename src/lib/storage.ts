import { createDefaultState } from "../data/defaults";
import type { AppState } from "../types";

const storageKey = "arknights-basement-state-v1";

export function loadState(): AppState {
  if (typeof window === "undefined") {
    return createDefaultState();
  }

  const raw = window.localStorage.getItem(storageKey);
  if (!raw) {
    return createDefaultState();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AppState>;
    const defaults = createDefaultState();
    return {
      roster: { ...defaults.roster, ...parsed.roster },
      facilities: parsed.facilities?.length ? parsed.facilities : defaults.facilities,
      preference: { ...defaults.preference, ...parsed.preference }
    };
  } catch {
    return createDefaultState();
  }
}

export function saveState(state: AppState): void {
  window.localStorage.setItem(storageKey, JSON.stringify(state));
}

export function exportState(state: AppState): string {
  return JSON.stringify(
    {
      version: 1,
      exportedAt: new Date().toISOString(),
      state
    },
    null,
    2
  );
}

export function importState(raw: string): AppState {
  const parsed = JSON.parse(raw) as unknown;
  const maybeState =
    isObject(parsed) && "state" in parsed ? (parsed.state as Partial<AppState> | undefined) : (parsed as Partial<AppState>);
  if (!maybeState?.roster || !maybeState.facilities || !maybeState.preference) {
    throw new Error("インポートJSONに必要な保存データがありません。");
  }

  return {
    roster: maybeState.roster,
    facilities: maybeState.facilities,
    preference: maybeState.preference
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
