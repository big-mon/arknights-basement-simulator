import { createDefaultState, createFacilitiesForLayout, isBaseLayout, isRotationCount } from "../data/defaults";
import { defaultLanguage, isLanguageCode } from "../i18n";
import type { AppState, BaseLayout, FacilitySlot, LanguageCode, RotationCount } from "../types";

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
    const layout = normalizeLayout(parsed.layout, parsed.facilities, defaults.layout);
    return {
      language: normalizeLanguage(parsed.language, defaults.language),
      layout,
      rotationCount: normalizeRotationCount(parsed.rotationCount, defaults.rotationCount),
      roster: { ...defaults.roster, ...parsed.roster },
      facilities: createFacilitiesForLayout(layout, parsed.facilities),
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

  const layout = normalizeLayout(maybeState.layout, maybeState.facilities, "243");
  return {
    language: normalizeLanguage(maybeState.language, defaultLanguage),
    layout,
    rotationCount: normalizeRotationCount(maybeState.rotationCount, 2),
    roster: maybeState.roster,
    facilities: createFacilitiesForLayout(layout, maybeState.facilities),
    preference: maybeState.preference
  };
}

function inferLayout(facilities?: FacilitySlot[]): BaseLayout | undefined {
  const tradingCount = facilities?.filter((facility) => facility.type === "trading").length;
  const factoryCount = facilities?.filter((facility) => facility.type === "factory").length;
  const powerCount = facilities?.filter((facility) => facility.type === "power").length;

  if (tradingCount === 1 && factoryCount === 5 && powerCount === 3) {
    return "153";
  }
  if (tradingCount === 2 && factoryCount === 4 && powerCount === 3) {
    return "243";
  }
  return undefined;
}

function normalizeLayout(layout: unknown, facilities: FacilitySlot[] | undefined, fallback: BaseLayout): BaseLayout {
  return isBaseLayout(layout) ? layout : inferLayout(facilities) ?? fallback;
}

function normalizeRotationCount(rotationCount: unknown, fallback: RotationCount): RotationCount {
  return isRotationCount(rotationCount) ? rotationCount : fallback;
}

function normalizeLanguage(language: unknown, fallback: LanguageCode): LanguageCode {
  return isLanguageCode(language) ? language : fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
