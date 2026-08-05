import type { FacilityType } from "../types";

const modeledFacilityLevelByType: Record<FacilityType, number> = {
  factory: 3,
  trading: 3,
  power: 3,
  control: 5,
  dormitory: 5,
  reception: 3
};

export function modeledFacilityLevel(facilityType: FacilityType): number {
  return modeledFacilityLevelByType[facilityType];
}
