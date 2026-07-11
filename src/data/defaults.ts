import type { AppState, BaseLayout, FacilitySlot, OptimizationPreference, Operator, ProductType, Roster, RotationCount } from "../types";
import operatorsData from "./operators.json";
import { defaultLevelForOperator } from "../lib/operatorLevel";
import { defaultLanguage } from "../i18n";

export const operators = operatorsData as Operator[];

export const defaultLayout: BaseLayout = "243";
export const defaultRotationCount: RotationCount = 2;

export function isBaseLayout(value: unknown): value is BaseLayout {
  return value === "243" || value === "153";
}

export function isRotationCount(value: unknown): value is RotationCount {
  return value === 2;
}

export const layoutPresets: Record<
  BaseLayout,
  { label: string; description: string; trading: number; factory: number; power: number }
> = {
  "243": {
    label: "243型",
    description: "貿易所2・製造所4・発電所3",
    trading: 2,
    factory: 4,
    power: 3
  },
  "153": {
    label: "153型",
    description: "貿易所1・製造所5・発電所3",
    trading: 1,
    factory: 5,
    power: 3
  }
};

const roomSuffixes = ["A", "B", "C", "D", "E"];

export function createFacilitiesForLayout(layout: BaseLayout, existingFacilities: FacilitySlot[] = []): FacilitySlot[] {
  const normalizedLayout = isBaseLayout(layout) ? layout : defaultLayout;
  const preset = layoutPresets[normalizedLayout];
  const existingFactoryProducts = existingFacilities
    .filter((facility) => facility.type === "factory")
    .map((facility) => facility.product);
  const defaultFactoryProducts: ProductType[] = ["gold", "gold", "battleRecord", "battleRecord", "battleRecord"];
  const preferredFactoryProducts = normalizeFactoryProducts(existingFactoryProducts, defaultFactoryProducts);

  return [
    ...createRoomSeries("trading", preset.trading, "貿易所", "lmd"),
    ...createRoomSeries(
      "factory",
      preset.factory,
      "製造所",
      "battleRecord",
      preferredFactoryProducts
    ),
    ...createRoomSeries("power", preset.power, "発電所", "power"),
    { id: "control-1", type: "control", name: "制御中枢", slotCount: 5, product: "lmd" },
    { id: "dormitory-1", type: "dormitory", name: "宿舎", slotCount: 5, product: "morale" }
  ];
}

function normalizeFactoryProducts(existingFactoryProducts: ProductType[], defaultFactoryProducts: ProductType[]) {
  if (!existingFactoryProducts.length) {
    return defaultFactoryProducts;
  }

  const legacyBalancedProducts: ProductType[] = ["gold", "battleRecord", "battleRecord", "battleRecord", "battleRecord"];
  const isLegacyBalanced = existingFactoryProducts.every((product, index) => product === legacyBalancedProducts[index]);
  return isLegacyBalanced ? defaultFactoryProducts : existingFactoryProducts;
}

function createRoomSeries(
  type: "trading" | "factory" | "power",
  count: number,
  label: string,
  defaultProduct: ProductType,
  preferredProducts: ProductType[] = []
): FacilitySlot[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${type}-${index + 1}`,
    type,
    name: `${label} ${roomSuffixes[index]}`,
    slotCount: type === "power" ? 1 : 3,
    product: preferredProducts[index] ?? defaultProduct
  }));
}

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
        owned: false,
        elite: 0,
        level: defaultLevelForOperator(operator),
        potential: 1,
        moduleEnabled: false
      }
    ])
  );
}

export function createDefaultState(): AppState {
  return {
    language: defaultLanguage,
    layout: defaultLayout,
    rotationCount: defaultRotationCount,
    roster: createDefaultRoster(),
    facilities: createFacilitiesForLayout(defaultLayout),
    preference: defaultPreference
  };
}
