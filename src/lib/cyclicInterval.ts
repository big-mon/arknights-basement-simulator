export interface HalfOpenInterval {
  startHour: number;
  endHour: number;
}

export function splitCyclicHalfOpenInterval(
  interval: HalfOpenInterval,
  cycleHours: number
): readonly HalfOpenInterval[] {
  if (!Number.isFinite(cycleHours) || cycleHours <= 0) return [];
  if (!Number.isFinite(interval.startHour) || !Number.isFinite(interval.endHour)) return [];

  const duration = interval.endHour - interval.startHour;
  if (!Number.isFinite(duration) || duration <= 0) return [];
  if (duration >= cycleHours) return [{ startHour: 0, endHour: cycleHours }];

  const startHour = ((interval.startHour % cycleHours) + cycleHours) % cycleHours;
  const endHour = startHour + duration;
  if (endHour <= cycleHours) return [{ startHour, endHour }];

  return [
    { startHour: 0, endHour: endHour - cycleHours },
    { startHour, endHour: cycleHours }
  ];
}

export function cyclicHalfOpenIntervalsOverlap(
  left: HalfOpenInterval,
  right: HalfOpenInterval,
  cycleHours: number
): boolean {
  const leftSegments = splitCyclicHalfOpenInterval(left, cycleHours);
  const rightSegments = splitCyclicHalfOpenInterval(right, cycleHours);
  return leftSegments.some((leftSegment) =>
    rightSegments.some((rightSegment) =>
      leftSegment.startHour < rightSegment.endHour &&
      rightSegment.startHour < leftSegment.endHour
    )
  );
}
