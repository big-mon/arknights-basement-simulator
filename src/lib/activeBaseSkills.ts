import type { BaseSkill, Operator } from "../types";
import { clampEliteForOperator } from "./elite";

export function activeBaseSkills(operator: Operator, elite: number, level: number): BaseSkill[] {
  const clampedElite = clampEliteForOperator(operator, elite);
  const normalizedLevel = Number.isFinite(level) ? Math.max(1, Math.trunc(level)) : 1;
  const activeBySlot = new Map<number, BaseSkill>();

  for (const skill of operator.skills) {
    const phaseUnlocked = skill.unlockPhase < clampedElite;
    const levelUnlocked = skill.unlockPhase === clampedElite && skill.unlockLevel <= normalizedLevel;
    if (!phaseUnlocked && !levelUnlocked) {
      continue;
    }

    const selected = activeBySlot.get(skill.slot);
    if (
      !selected ||
      skill.unlockPhase > selected.unlockPhase ||
      (skill.unlockPhase === selected.unlockPhase && skill.unlockLevel > selected.unlockLevel)
    ) {
      activeBySlot.set(skill.slot, skill);
    }
  }

  return [...activeBySlot.values()].sort((a, b) => a.slot - b.slot);
}
