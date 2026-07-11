import type { Operator } from "../types";

export function levelOptionsForOperator(operator: Operator): number[] {
  const unlockLevels = operator.skills
    .map((skill) => skill.unlockLevel)
    .filter((level) => level > 1);

  return unlockLevels.length ? [1, ...new Set(unlockLevels)].sort((a, b) => a - b) : [];
}

export function defaultLevelForOperator(operator: Operator): number {
  return Math.max(...levelOptionsForOperator(operator), 1);
}

export function effectiveLevelForOperator(operator: Operator, level: number): number {
  const options = levelOptionsForOperator(operator);
  return options.filter((option) => option <= level).at(-1) ?? options[0] ?? 1;
}
