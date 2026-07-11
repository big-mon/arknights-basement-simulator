import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const operators = JSON.parse(await readFile(path.join(root, "src", "data", "operators.json"), "utf8"));
const skills = operators.flatMap((operator) => operator.skills.map((skill) => ({ operator, skill })));
const effects = skills.flatMap(({ operator, skill }) => skill.effects.map((effect) => ({ operator, skill, effect })));

const structurallyInvalid = skills.filter(
  ({ skill }) =>
    !Number.isInteger(skill.slot) ||
    !Number.isInteger(skill.unlockLevel) ||
    skill.unlockLevel < 1 ||
    ![0, 1, 2].includes(skill.unlockPhase)
);
const invalidEffects = effects.filter(
  ({ effect }) => !Number.isFinite(effect.efficiency) || (effect.baseEfficiency !== undefined && !Number.isFinite(effect.baseEfficiency))
);
const zeroValueEffects = effects.filter(({ effect }) => {
  if (effect.ignoredForOptimization || effect.efficiency !== 0 || (effect.baseEfficiency ?? 0) !== 0) {
    return false;
  }
  return !(
    effect.storageLimit ||
    effect.orderLimit ||
    effect.globalEffect ||
    effect.moraleEffects?.length ||
    effect.moraleCurve ||
    effect.activation ||
    effect.resourceEffects?.length ||
    effect.facilityCountBonuses?.length
  );
});
const sameFacilityActiveSlots = operators.flatMap((operator) => {
  const activeBySlot = new Map();
  for (const skill of operator.skills) {
    const selected = activeBySlot.get(skill.slot);
    if (
      !selected ||
      skill.unlockPhase > selected.unlockPhase ||
      (skill.unlockPhase === selected.unlockPhase && skill.unlockLevel > selected.unlockLevel)
    ) {
      activeBySlot.set(skill.slot, skill);
    }
  }
  const byFacility = new Map();
  for (const skill of activeBySlot.values()) {
    for (const facility of new Set(skill.effects.map((effect) => effect.facility))) {
      byFacility.set(facility, [...(byFacility.get(facility) ?? []), skill.id]);
    }
  }
  return [...byFacility.entries()]
    .filter(([, facilitySkills]) => facilitySkills.length > 1)
    .map(([facility, facilitySkills]) => ({ operatorId: operator.id, facility, skills: facilitySkills }));
});
const suspiciousCapacityEfficiency = effects
  .filter(
    ({ effect }) =>
      effect.efficiency !== 0 &&
      (effect.storageLimit !== undefined || effect.orderLimit !== undefined) &&
      !/%/.test(effect.description.en ?? "")
  )
  .map(({ operator, skill, effect }) => ({
    key: `${operator.id}:${skill.id}`,
    efficiency: effect.efficiency,
    storageLimit: effect.storageLimit,
    orderLimit: effect.orderLimit,
    description: effect.description.en
  }));
const suspiciousNonPercentageEfficiency = effects
  .filter(
    ({ effect }) =>
      effect.efficiency > 0 &&
      !/%/.test(effect.description.en ?? "") &&
      !effect.ignoredForOptimization &&
      !effect.unsupportedReason
  )
  .map(({ operator, skill, effect }) => ({
    key: `${operator.id}:${skill.id}`,
    efficiency: effect.efficiency,
    description: effect.description.en
  }));
const zeroValueEffectsByFacility = Object.fromEntries(
  [...new Set(zeroValueEffects.map(({ effect }) => effect.facility))]
    .sort()
    .map((facility) => [facility, zeroValueEffects.filter(({ effect }) => effect.facility === facility).length])
);
const unclassifiedProductionEffects = zeroValueEffects
  .filter(({ effect }) => ["factory", "trading", "power"].includes(effect.facility) && effect.product !== "morale")
  .map(({ operator, skill }) => `${operator.id}:${skill.id}`);
const unmodeledProductionCurves = effects
  .filter(({ effect }) => {
    const description = effect.description.en ?? "";
    return (
      !effect.ignoredForOptimization &&
      !effect.timeCurve &&
      !effect.moraleCurve &&
      !effect.activation &&
      (/(?:productivity|drone recovery rate).*?in the first hour.*?per hour/i.test(description) ||
        /productivity per hour.*?up to/i.test(description) ||
        /(?:increases by|speed increases).*?then by another.*?per hour/i.test(description) ||
        /Morale difference/i.test(description))
    );
  })
  .map(({ operator, skill }) => `${operator.id}:${skill.id}`);
const moraleDescriptionsWithoutModel = effects
  .filter(
    ({ effect }) =>
      /morale/i.test(effect.description.en ?? "") &&
      !effect.ignoredForOptimization &&
      !effect.moraleEffects?.length &&
      !effect.moraleCurve &&
      !effect.activation &&
      !effect.globalEffect &&
      !effect.resourceEffects?.length
  )
  .map(({ operator, skill }) => `${operator.id}:${skill.id}`);

console.log(
  JSON.stringify(
    {
      totals: { operators: operators.length, skills: skills.length, effects: effects.length },
      ignoredEffects: effects.filter(({ effect }) => effect.ignoredForOptimization).length,
      unsupportedEffects: effects.filter(({ effect }) => effect.unsupportedReason).length,
      zeroValueEffectsByFacility,
      unclassifiedProductionEffects,
      suspiciousCapacityEfficiencyCount: suspiciousCapacityEfficiency.length,
      suspiciousNonPercentageEfficiencyCount: suspiciousNonPercentageEfficiency.length,
      sameFacilityActiveSlotCount: sameFacilityActiveSlots.length,
      modeledTimeCurves: effects.filter(({ effect }) => effect.timeCurve).length,
      modeledMoraleCurves: effects.filter(({ effect }) => effect.moraleCurve).length,
      unmodeledProductionCurves,
      moraleDescriptionsWithoutModel
    },
    null,
    2
  )
);

if (
  structurallyInvalid.length ||
  invalidEffects.length ||
  unclassifiedProductionEffects.length ||
  unmodeledProductionCurves.length ||
  moraleDescriptionsWithoutModel.length
) {
  console.error(
    JSON.stringify({ structurallyInvalid: structurallyInvalid.length, invalidEffects: invalidEffects.length }, null, 2)
  );
  process.exitCode = 1;
}
