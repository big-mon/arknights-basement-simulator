import type { ScheduleShift, ScheduleState } from "../types";

/** Schedule boundaries are compared in hours with this absolute epsilon. */
export const scheduleEpsilonHours = 1e-9;

export type ScheduleValidationResult =
  | { ok: true; value: ScheduleState }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= scheduleEpsilonHours;
}

function normalizeGroupIds(value: unknown, path: string, knownGroups: Set<string>, errors: string[]): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  value.forEach((id, index) => {
    if (!validId(id)) {
      errors.push(`${path}[${index}] must be a stable non-empty ID`);
      return;
    }
    if (seen.has(id)) errors.push(`${path} contains duplicate group ID ${id}`);
    if (!knownGroups.has(id)) errors.push(`${path} references unknown group ${id}`);
    seen.add(id);
    result.push(id);
  });
  return result;
}

export function validateSchedule(value: unknown): ScheduleValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["schedule must be an object"] };
  const cycleHours = value.cycleHours;
  if (!finite(cycleHours) || cycleHours <= 0) errors.push("cycleHours must be a finite positive number");

  const rawGroups = Array.isArray(value.groups) ? value.groups : [];
  if (!Array.isArray(value.groups) || rawGroups.length === 0) errors.push("groups must not be empty");
  const groups: Array<{ id: string }> = [];
  const knownGroups = new Set<string>();
  rawGroups.forEach((group, index) => {
    const id = isRecord(group) ? group.id : undefined;
    if (!validId(id)) {
      errors.push(`groups[${index}].id must be a stable non-empty ID`);
      return;
    }
    if (knownGroups.has(id)) errors.push(`duplicate group ID: ${id}`);
    knownGroups.add(id);
    groups.push({ id });
  });

  const rawShifts = Array.isArray(value.shifts) ? value.shifts : [];
  if (!Array.isArray(value.shifts) || rawShifts.length === 0) errors.push("shifts must not be empty");
  const seenShiftIds = new Set<string>();
  const activeGroupIdsAcrossShifts = new Set<string>();
  const shifts: ScheduleShift[] = [];
  rawShifts.forEach((shift, index) => {
    const path = `shifts[${index}]`;
    if (!isRecord(shift)) {
      errors.push(`${path} must be an object`);
      return;
    }
    const id = shift.id;
    if (!validId(id)) errors.push(`${path}.id must be a stable non-empty ID`);
    else if (seenShiftIds.has(id)) errors.push(`duplicate shift ID: ${id}`);
    else seenShiftIds.add(id);
    const startHour = shift.startHour;
    const endHour = shift.endHour;
    if (!finite(startHour) || !finite(endHour)) errors.push(`${path} boundaries must be finite numbers`);
    else {
      if (startHour < -scheduleEpsilonHours || endHour > (finite(cycleHours) ? cycleHours : 0) + scheduleEpsilonHours) {
        errors.push(`${path} boundaries must be within the cycle`);
      }
      if (endHour - startHour <= scheduleEpsilonHours) errors.push(`${path} must have positive duration`);
    }
    const activeGroupIds = normalizeGroupIds(shift.activeGroupIds, `${path}.activeGroupIds`, knownGroups, errors);
    const recoveryGroupIds = normalizeGroupIds(shift.recoveryGroupIds, `${path}.recoveryGroupIds`, knownGroups, errors);
    if (activeGroupIds.length === 0) errors.push(`${path}.activeGroupIds must not be empty`);
    for (const groupId of activeGroupIds) {
      activeGroupIdsAcrossShifts.add(groupId);
      if (recoveryGroupIds.includes(groupId)) errors.push(`${path} group ${groupId} cannot be active and recovering simultaneously`);
    }
    if (validId(id) && finite(startHour) && finite(endHour)) {
      shifts.push({ id, startHour, endHour, activeGroupIds, recoveryGroupIds });
    }
  });

  for (const group of groups) {
    if (!activeGroupIdsAcrossShifts.has(group.id)) errors.push(`group ${group.id} must be active in at least one shift`);
  }

  shifts.sort((left, right) => left.startHour - right.startHour || left.endHour - right.endHour || left.id.localeCompare(right.id));
  if (finite(cycleHours) && cycleHours > 0 && shifts.length > 0) {
    let boundary = 0;
    shifts.forEach((shift, index) => {
      if (!close(shift.startHour, boundary)) {
        errors.push(`shifts[${index}] creates a ${shift.startHour > boundary ? "gap" : "overlap"} at hour ${boundary}`);
      }
      boundary = shift.endHour;
    });
    if (!close(boundary, cycleHours)) errors.push(`shifts do not cover cycleHours ${cycleHours}`);
  }

  if (errors.length > 0 || !finite(cycleHours)) return { ok: false, errors };
  return { ok: true, value: { cycleHours, groups, shifts } };
}

export function normalizeSchedule(value: unknown): ScheduleState {
  const result = validateSchedule(value);
  if (!result.ok) throw new RangeError(`invalid schedule: ${result.errors.join("; ")}`);
  return result.value;
}
