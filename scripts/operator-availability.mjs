const playableProfessions = new Set([
  "PIONEER",
  "WARRIOR",
  "TANK",
  "SNIPER",
  "CASTER",
  "MEDIC",
  "SUPPORT",
  "SPECIAL"
]);

export function extractAvailableOperatorIds(characterTable) {
  return Object.entries(characterTable ?? {})
    .filter(([operatorId, character]) =>
      operatorId.startsWith("char_") &&
      typeof character?.name === "string" &&
      character.name.trim().length > 0 &&
      character.isNotObtainable === false &&
      playableProfessions.has(character.profession)
    )
    .map(([operatorId]) => operatorId)
    .sort();
}

export function buildOperatorAvailabilitySnapshot({ regions }) {
  return {
    schemaVersion: 1,
    regions: Object.fromEntries(
      ["JP", "CN"].map((region) => [
        region,
        {
          source: { ...regions[region].source },
          operatorIds: extractAvailableOperatorIds(regions[region].characterTable)
        }
      ])
    )
  };
}
