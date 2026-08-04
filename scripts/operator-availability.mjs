export function extractAvailableOperatorIds(characterTable, catalogOperatorIds) {
  const tableOperatorIds = new Set(Object.keys(characterTable ?? {}));
  return catalogOperatorIds.filter((operatorId) => tableOperatorIds.has(operatorId));
}

export function buildOperatorAvailabilitySnapshot({ catalogOperatorIds, regions }) {
  return {
    schemaVersion: 1,
    regions: Object.fromEntries(
      ["JP", "CN"].map((region) => [
        region,
        {
          source: { ...regions[region].source },
          operatorIds: extractAvailableOperatorIds(regions[region].characterTable, catalogOperatorIds)
        }
      ])
    )
  };
}
