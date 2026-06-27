import type { AppState, FacilitySlot, OptimizationPreference, Operator, Roster } from "../types";
import operatorsData from "./operators.json";

export const operators = operatorsData as Operator[];

export const defaultFacilities: FacilitySlot[] = [
  { id: "factory-1", type: "factory", name: "製造所 A", slotCount: 3, product: "gold", enabled: true },
  { id: "factory-2", type: "factory", name: "製造所 B", slotCount: 3, product: "battleRecord", enabled: true },
  { id: "factory-3", type: "factory", name: "製造所 C", slotCount: 3, product: "battleRecord", enabled: true },
  { id: "trading-1", type: "trading", name: "貿易所 A", slotCount: 3, product: "lmd", enabled: true },
  { id: "trading-2", type: "trading", name: "貿易所 B", slotCount: 3, product: "lmd", enabled: true },
  { id: "power-1", type: "power", name: "発電所 A", slotCount: 1, product: "power", enabled: true },
  { id: "power-2", type: "power", name: "発電所 B", slotCount: 1, product: "power", enabled: true },
  { id: "control-1", type: "control", name: "制御中枢", slotCount: 5, product: "lmd", enabled: true },
  { id: "dormitory-1", type: "dormitory", name: "宿舎 A", slotCount: 5, product: "morale", enabled: true }
];

export const defaultPreference: OptimizationPreference = {
  gold: 0.35,
  battleRecord: 0.35,
  lmd: 0.30
};

export function createDefaultRoster(): Roster {
  return Object.fromEntries(
    operators.map((operator) => [
      operator.id,
      {
        owned: operator.rarity <= 4,
        elite: operator.rarity <= 3 ? 1 : 0,
        level: 1,
        potential: 1,
        moduleEnabled: false
      }
    ])
  );
}

export function createDefaultState(): AppState {
  return {
    roster: createDefaultRoster(),
    facilities: defaultFacilities,
    preference: defaultPreference
  };
}
