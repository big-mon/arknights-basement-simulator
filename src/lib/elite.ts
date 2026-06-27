import type { Operator, RosterEntry } from "../types";

export function maxEliteForRarity(rarity: Operator["rarity"]): RosterEntry["elite"] {
  if (rarity <= 2) {
    return 0;
  }
  if (rarity === 3) {
    return 1;
  }
  return 2;
}

export function clampEliteForOperator(operator: Operator, elite: unknown): RosterEntry["elite"] {
  const numericElite = typeof elite === "number" ? elite : Number(elite);
  const normalizedElite = numericElite === 1 || numericElite === 2 ? numericElite : 0;
  return Math.min(normalizedElite, maxEliteForRarity(operator.rarity)) as RosterEntry["elite"];
}

export function eliteOptionsForOperator(operator: Operator): RosterEntry["elite"][] {
  const maxElite = maxEliteForRarity(operator.rarity);
  return ([0, 1, 2] as RosterEntry["elite"][]).filter((elite) => elite <= maxElite);
}
