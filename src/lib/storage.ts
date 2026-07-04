import { createDefaultState, createFacilitiesForLayout, isBaseLayout, isRotationCount, operators } from "../data/defaults";
import { isLanguageCode } from "../i18n";
import { clampEliteForOperator } from "./elite";
import type {
  AppState,
  BaseLayout,
  FacilitySlot,
  FacilityType,
  LanguageCode,
  OptimizationPreference,
  ProductType,
  Roster,
  RosterEntry,
  RotationCount
} from "../types";

const storageKey = "arknights-basement-state-v1";
export const maxImportJsonBytes = 128 * 1024;

export function loadState(): AppState {
  if (typeof window === "undefined") {
    return createDefaultState();
  }

  const raw = window.localStorage.getItem(storageKey);
  if (!raw) {
    return createDefaultState();
  }

  try {
    return normalizeState(JSON.parse(raw) as unknown, createDefaultState(), false);
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
  if (byteLength(raw) > maxImportJsonBytes) {
    throw new Error(`JSONファイルは${maxImportJsonBytes / 1024}KiB以下にしてください。`);
  }

  return normalizeState(JSON.parse(raw) as unknown, createDefaultState(), true);
}

function normalizeState(parsed: unknown, defaults: AppState, requireRecognizedShape: boolean): AppState {
  const maybeState = isObject(parsed) && "state" in parsed ? parsed.state : parsed;

  if (!isObject(maybeState) || (requireRecognizedShape && !hasRecognizedStateShape(maybeState))) {
    throw new Error("インポートJSONに必要な保存データがありません。");
  }

  const facilities = normalizeFacilities(maybeState.facilities);
  const layout = normalizeLayout(maybeState.layout, facilities, defaults.layout);

  return {
    language: normalizeLanguage(maybeState.language, defaults.language),
    layout,
    rotationCount: normalizeRotationCount(maybeState.rotationCount, defaults.rotationCount),
    roster: normalizeRoster(maybeState.roster),
    facilities: createFacilitiesForLayout(layout, facilities),
    preference: normalizePreference(maybeState.preference, defaults.preference)
  };
}

function normalizeRoster(roster: unknown): Roster {
  const defaults = createDefaultState().roster;

  return Object.fromEntries(
    operators.map((operator) => {
      const defaultEntry = defaults[operator.id];
      const candidateEntry = isObject(roster) ? roster[operator.id] : undefined;
      const entry: Record<string, unknown> | undefined = isObject(candidateEntry) ? candidateEntry : undefined;

      return [
        operator.id,
        {
          owned: typeof entry?.["owned"] === "boolean" ? entry["owned"] : defaultEntry.owned,
          elite: clampEliteForOperator(operator, entry?.["elite"]),
          level: normalizeInteger(entry?.["level"], defaultEntry.level, 1, 90),
          potential: normalizeInteger(entry?.["potential"], defaultEntry.potential, 1, 6),
          moduleEnabled: typeof entry?.["moduleEnabled"] === "boolean" ? entry["moduleEnabled"] : defaultEntry.moduleEnabled
        } satisfies RosterEntry
      ];
    })
  );
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

function normalizePreference(preference: unknown, fallback: OptimizationPreference): OptimizationPreference {
  return {
    gold: normalizeRatio(isObject(preference) ? preference.gold : undefined, fallback.gold),
    battleRecord: normalizeRatio(isObject(preference) ? preference.battleRecord : undefined, fallback.battleRecord),
    lmd: normalizeRatio(isObject(preference) ? preference.lmd : undefined, fallback.lmd)
  };
}

function normalizeFacilities(facilities: unknown): FacilitySlot[] | undefined {
  if (!Array.isArray(facilities)) {
    return undefined;
  }

  return facilities.flatMap((facility, index) => {
    if (!isObject(facility) || !isFacilityType(facility.type) || !isProductType(facility.product)) {
      return [];
    }

    return [
      {
        id: typeof facility.id === "string" ? facility.id : `${facility.type}-${index + 1}`,
        type: facility.type,
        name: typeof facility.name === "string" ? facility.name : "",
        slotCount: normalizeInteger(facility.slotCount, defaultSlotCount(facility.type), 1, 5),
        product: facility.product
      }
    ];
  });
}

function normalizeRatio(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function normalizeInteger(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    return fallback;
  }
  return value;
}

function hasRecognizedStateShape(value: Record<string, unknown>) {
  return (
    isObject(value.roster) ||
    Array.isArray(value.facilities) ||
    isObject(value.preference) ||
    isBaseLayout(value.layout) ||
    isRotationCount(value.rotationCount) ||
    isLanguageCode(value.language)
  );
}

function isFacilityType(value: unknown): value is FacilityType {
  return value === "factory" || value === "trading" || value === "power" || value === "control" || value === "dormitory" || value === "reception";
}

function isProductType(value: unknown): value is ProductType {
  return value === "gold" || value === "battleRecord" || value === "originium" || value === "lmd" || value === "power" || value === "morale" || value === "clue";
}

function defaultSlotCount(type: FacilityType) {
  return type === "power" ? 1 : type === "control" || type === "dormitory" ? 5 : 3;
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).length;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
