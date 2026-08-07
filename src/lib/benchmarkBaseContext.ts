import baseMechanics from "../data/optimizer-benchmarks/base-mechanics-2026-07.json";

export type BenchmarkFactoryProduct = "gold" | "battleRecord";

interface BenchmarkFacilityBase {
  id: string;
  level: number;
  slotCount: number;
}

export interface BenchmarkTradingPost extends BenchmarkFacilityBase {
  type: "trading";
  order: "lmd";
}

export interface BenchmarkFactory extends BenchmarkFacilityBase {
  type: "factory";
  product: BenchmarkFactoryProduct;
}

export interface BenchmarkPowerPlant extends BenchmarkFacilityBase {
  type: "power";
}

export interface BenchmarkControlCenter extends BenchmarkFacilityBase {
  type: "control";
}

export interface BenchmarkDormitory extends BenchmarkFacilityBase {
  type: "dormitory";
  maxAmbience: number;
}

export interface BenchmarkReceptionRoom extends BenchmarkFacilityBase {
  type: "reception";
}

export interface BenchmarkOffice extends BenchmarkFacilityBase {
  type: "office";
  recruitmentSlotCount: number;
}

export interface BenchmarkWorkshop extends BenchmarkFacilityBase {
  type: "workshop";
}

export interface BenchmarkTrainingRoom extends BenchmarkFacilityBase {
  type: "training";
}

export type BenchmarkFacility =
  | BenchmarkTradingPost
  | BenchmarkFactory
  | BenchmarkPowerPlant
  | BenchmarkControlCenter
  | BenchmarkDormitory
  | BenchmarkReceptionRoom
  | BenchmarkOffice
  | BenchmarkWorkshop
  | BenchmarkTrainingRoom;

export interface BenchmarkBaseContext {
  layout: "243";
  facilities: BenchmarkFacility[];
  droneCap: number;
}

export type BenchmarkBaseContextValidationResult =
  | { ok: true; value: BenchmarkBaseContext }
  | { ok: false; errors: string[] };

const facilityTypes = [
  "trading",
  "factory",
  "power",
  "control",
  "dormitory",
  "reception",
  "office",
  "workshop",
  "training"
] as const;

type BenchmarkFacilityType = (typeof facilityTypes)[number];

const expectedFacilityCounts: Record<BenchmarkFacilityType, number> = {
  trading: 2,
  factory: 4,
  power: 3,
  control: 1,
  dormitory: 4,
  reception: 1,
  office: 1,
  workshop: 1,
  training: 1
};

const facilitySpecifications: Record<BenchmarkFacilityType, { level: number; slotCount: number }> = {
  trading: { level: 3, slotCount: 3 },
  factory: { level: 3, slotCount: 3 },
  power: { level: 3, slotCount: 1 },
  control: { level: 5, slotCount: 5 },
  dormitory: { level: 5, slotCount: 5 },
  reception: { level: 3, slotCount: 2 },
  office: { level: 3, slotCount: 1 },
  workshop: { level: 3, slotCount: 1 },
  training: { level: 3, slotCount: 2 }
};

function documentedMechanic(id: string): number {
  const value = baseMechanics.formulas.find((formula) => formula.id === id)?.expectedValue;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`base-mechanics-2026-07 is missing the finite ${id} constant`);
  }
  return value;
}

export const maxLevel243DroneCap = documentedMechanic("drone-cap");

export function createMaxLevel243BenchmarkContext(): BenchmarkBaseContext {
  return {
    layout: "243",
    facilities: [
      { id: "trading-1", type: "trading", level: 3, slotCount: 3, order: "lmd" },
      { id: "trading-2", type: "trading", level: 3, slotCount: 3, order: "lmd" },
      { id: "factory-1", type: "factory", level: 3, slotCount: 3, product: "gold" },
      { id: "factory-2", type: "factory", level: 3, slotCount: 3, product: "gold" },
      { id: "factory-3", type: "factory", level: 3, slotCount: 3, product: "battleRecord" },
      { id: "factory-4", type: "factory", level: 3, slotCount: 3, product: "battleRecord" },
      { id: "power-1", type: "power", level: 3, slotCount: 1 },
      { id: "power-2", type: "power", level: 3, slotCount: 1 },
      { id: "power-3", type: "power", level: 3, slotCount: 1 },
      { id: "control-1", type: "control", level: 5, slotCount: 5 },
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `dormitory-${index + 1}`,
        type: "dormitory" as const,
        level: 5,
        slotCount: 5,
        maxAmbience: 5000
      })),
      { id: "reception-1", type: "reception", level: 3, slotCount: 2 },
      { id: "office-1", type: "office", level: 3, slotCount: 1, recruitmentSlotCount: 4 },
      { id: "workshop-1", type: "workshop", level: 3, slotCount: 1 },
      { id: "training-1", type: "training", level: 3, slotCount: 2 }
    ],
    droneCap: maxLevel243DroneCap
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === undefined) return "missing";
  return JSON.stringify(value);
}

function expectValue(
  actual: unknown,
  expected: string | number,
  path: string,
  errors: string[]
): void {
  if (actual !== expected) errors.push(`${path}: expected ${expected}, received ${describeValue(actual)}`);
}

export function validateBenchmarkBaseContext(input: unknown): BenchmarkBaseContextValidationResult {
  if (!isRecord(input)) return { ok: false, errors: ["benchmark base context must be an object"] };

  const errors: string[] = [];
  expectValue(input.layout, "243", "layout", errors);
  expectValue(input.droneCap, maxLevel243DroneCap, "droneCap", errors);

  if (!Array.isArray(input.facilities)) {
    return { ok: false, errors: [...errors, "facilities must be an array"] };
  }

  const facilitiesByType = new Map<BenchmarkFacilityType, Record<string, unknown>[]>();
  for (const type of facilityTypes) facilitiesByType.set(type, []);
  const facilityIds = new Set<string>();

  input.facilities.forEach((facility, index) => {
    if (!isRecord(facility)) {
      errors.push(`facilities[${index}] must be an object`);
      return;
    }

    if (typeof facility.id !== "string" || facility.id.length === 0) {
      errors.push(`facilities[${index}].id must be a non-empty string`);
    } else if (facilityIds.has(facility.id)) {
      errors.push(`duplicate facility ID: ${facility.id}`);
    } else {
      facilityIds.add(facility.id);
    }

    if (!facilityTypes.includes(facility.type as BenchmarkFacilityType)) {
      errors.push(`${describeValue(facility.id)}.type: unsupported facility type ${describeValue(facility.type)}`);
      return;
    }
    facilitiesByType.get(facility.type as BenchmarkFacilityType)?.push(facility);
  });

  for (const type of facilityTypes) {
    const facilities = facilitiesByType.get(type) ?? [];
    expectValue(facilities.length, expectedFacilityCounts[type], `${type} facilities`, errors);
    for (const facility of facilities) {
      const path = typeof facility.id === "string" && facility.id.length > 0 ? facility.id : type;
      expectValue(facility.level, facilitySpecifications[type].level, `${path}.level`, errors);
      expectValue(facility.slotCount, facilitySpecifications[type].slotCount, `${path}.slotCount`, errors);

      if (type === "trading") expectValue(facility.order, "lmd", `${path}.order`, errors);
      if (type === "dormitory") expectValue(facility.maxAmbience, 5000, `${path}.maxAmbience`, errors);
      if (type === "office") expectValue(facility.recruitmentSlotCount, 4, `${path}.recruitmentSlotCount`, errors);
    }
  }

  const factoryProducts = (facilitiesByType.get("factory") ?? []).map((facility) => facility.product);
  const goldFactoryCount = factoryProducts.filter((product) => product === "gold").length;
  const battleRecordFactoryCount = factoryProducts.filter((product) => product === "battleRecord").length;
  if (goldFactoryCount !== 2 || battleRecordFactoryCount !== 2) {
    errors.push(`factory products: expected exactly 2 gold and 2 battleRecord, received ${factoryProducts.map(describeValue).join(",")}`);
  }

  return errors.length === 0
    ? { ok: true, value: input as unknown as BenchmarkBaseContext }
    : { ok: false, errors };
}
