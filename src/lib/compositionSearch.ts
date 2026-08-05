export interface ConflictFreeSearchOption<T> {
  stableId: string;
  score: number;
  /** Mechanical feasibility preference used only after objective score. */
  feasibilityRank?: number;
  operatorIds?: readonly string[];
  conflictKeys?: readonly string[];
  retentionKeys?: readonly string[];
  /** Required dimensions reject options explicitly marked as not filling them. */
  fillsDimension?: boolean;
  value: T;
}

export interface ConflictFreeSearchDimension<T> {
  stableId: string;
  options: readonly ConflictFreeSearchOption<T>[];
  required?: boolean;
}

export interface ConflictFreeSearchDiagnostic {
  optimality: "certified" | "not-certified";
  limitation?: "prefrontier-limited" | "frontier-limited" | "feasibility-budget-limited" |
    "optimization-budget-limited";
  completion: "complete" | "infeasible" | "unknown";
  visitedStates: number;
  discardedStates: number;
  feasibilityVisitedStates: number;
  feasibilityWorkBudget: number;
  feasibilityBudgetExhausted: boolean;
  optimizationVisitedStates: number;
  optimizationWorkBudget: number;
  optimizationBudgetExhausted: boolean;
  incompleteDimensionIds: readonly string[];
}

export interface ConflictFreeSearchResult<T> {
  options: readonly ConflictFreeSearchOption<T>[];
  diagnostic: ConflictFreeSearchDiagnostic;
}

export interface ConflictFreeSearchConstraints<T> {
  isCompleteSelectionFeasible?: (
    options: readonly ConflictFreeSearchOption<T>[]
  ) => boolean;
  completeSelectionEvaluationBudget?: number;
}

export interface ConflictFreePrefrontierInspection {
  dimensionOptions: Readonly<Record<string, readonly string[]>>;
  discardedOptions: number;
}

type IndexedOption<T> = ConflictFreeSearchOption<T> & { keys: readonly string[] };
type IndexedDimension<T> = {
  stableId: string;
  required: boolean;
  options: readonly IndexedOption<T>[];
};

const prefrontierSize = 64;
const largeSeedFrontierSize = 32;
const exactCombinationLimit = 100_000;
const feasibilityWorkBudget = 200_000;
const optimizationWorkBudget = 50_000;
const incumbentWorkBudget = 5_000;
const defaultCompleteSelectionEvaluationBudget = 12;

function compareCodePoints(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function optionSignature<T>(option: IndexedOption<T>) {
  return `${option.stableId}\u0001${option.keys.join("\u0000")}`;
}

function compareOptions<T>(left: IndexedOption<T>, right: IndexedOption<T>) {
  return right.score - left.score ||
    (right.feasibilityRank ?? 0) - (left.feasibilityRank ?? 0) ||
    compareCodePoints(left.stableId, right.stableId) ||
    compareCodePoints(left.keys.join("\u0000"), right.keys.join("\u0000"));
}

function dimensionHasScoredOptions<T>(dimension: IndexedDimension<T>) {
  return (dimension.options[0]?.score ?? 0) > 0;
}

function normalizeDimensions<T>(dimensions: readonly ConflictFreeSearchDimension<T>[]): IndexedDimension<T>[] {
  return [...dimensions]
    .sort((left, right) => compareCodePoints(left.stableId, right.stableId))
    .map((dimension) => ({
      stableId: dimension.stableId,
      required: dimension.required !== false,
      options: dimension.options
        .map((option) => ({
          ...option,
          keys: [...new Set(option.conflictKeys ?? option.operatorIds ?? [])]
            .sort(compareCodePoints)
        }))
        .sort(compareOptions)
    }));
}

function reducePrefrontier<T>(
  dimension: IndexedDimension<T>,
  allDimensions: readonly IndexedDimension<T>[]
) {
  if (dimension.options.length <= prefrontierSize) {
    return { dimension, discarded: 0 };
  }

  const retained = new Map<string, IndexedOption<T>>();
  const retain = (option: IndexedOption<T> | undefined) => {
    if (option) retained.set(optionSignature(option), option);
  };
  dimension.options.slice(0, prefrontierSize).forEach(retain);

  const retentionKeys = new Set<string>();
  for (const candidate of dimension.options) {
    for (const key of [...(candidate.retentionKeys ?? [])].sort(compareCodePoints)) {
      if (retentionKeys.has(key)) continue;
      retentionKeys.add(key);
      retain(candidate);
    }
  }

  const minimumConflictCount = Math.min(...dimension.options.map((candidate) => candidate.keys.length));
  retain(dimension.options.find((candidate) => candidate.keys.length === minimumConflictCount));

  for (const other of allDimensions) {
    if (other.stableId === dimension.stableId) continue;
    const requirements = new Map<string, readonly string[]>();
    for (const candidate of other.options) {
      const signature = candidate.keys.join("\u0000");
      if (!requirements.has(signature)) requirements.set(signature, candidate.keys);
    }
    for (const requirement of requirements.values()) {
      retain(dimension.options.find((candidate) =>
        candidate.keys.every((key) => !requirement.includes(key))
      ));
    }
  }

  const options = [...retained.values()].sort(compareOptions);
  return {
    dimension: { ...dimension, options },
    discarded: dimension.options.length - options.length
  };
}

function buildPrefrontier<T>(dimensions: readonly IndexedDimension<T>[]) {
  const reduced = dimensions.map((dimension) => reducePrefrontier(dimension, dimensions));
  return {
    dimensions: reduced.map(({ dimension }) => dimension),
    discarded: reduced.reduce((sum, item) => sum + item.discarded, 0)
  };
}

export function inspectConflictFreePrefrontier<T>(
  dimensions: readonly ConflictFreeSearchDimension<T>[]
): ConflictFreePrefrontierInspection {
  const normalized = normalizeDimensions(dimensions);
  const reduced = buildPrefrontier(normalized);
  return {
    dimensionOptions: Object.freeze(Object.fromEntries(reduced.dimensions.map((dimension) => [
      dimension.stableId,
      Object.freeze(dimension.options.map((candidate) => candidate.stableId))
    ]))),
    discardedOptions: reduced.discarded
  };
}

type SearchState<T> = {
  score: number;
  usedKeys: ReadonlySet<string>;
  selected: readonly IndexedOption<T>[];
};

function stateSignature<T>(state: SearchState<T>) {
  return state.selected.map((option) => option.stableId).join("|");
}

function compareStates<T>(left: SearchState<T>, right: SearchState<T>) {
  return right.score - left.score || compareCodePoints(stateSignature(left), stateSignature(right));
}

function exhaustiveSearch<T>(
  dimensions: readonly IndexedDimension<T>[],
  isCompleteSelectionFeasible?: (options: readonly IndexedOption<T>[]) => boolean
) {
  const remainingUpperBounds = dimensions.map((_, index) =>
    dimensions.slice(index).reduce((sum, dimension) => sum + (dimension.options[0]?.score ?? 0), 0)
  );
  let best: SearchState<T> | undefined;
  let visitedStates = 0;
  let firstDeadDimensionId: string | undefined;

  const visit = (index: number, state: SearchState<T>) => {
    if (index === dimensions.length) {
      if (isCompleteSelectionFeasible && !isCompleteSelectionFeasible(state.selected)) return;
      if (!best || compareStates(state, best) < 0) best = state;
      return;
    }
    if (best && state.score + remainingUpperBounds[index] < best.score) return;
    let expanded = false;
    for (const candidate of dimensions[index].options) {
      visitedStates += 1;
      if (candidate.keys.some((key) => state.usedKeys.has(key))) continue;
      expanded = true;
      visit(index + 1, {
        score: state.score + candidate.score,
        usedKeys: new Set([...state.usedKeys, ...candidate.keys]),
        selected: [...state.selected, candidate]
      });
    }
    if (!expanded && firstDeadDimensionId === undefined) firstDeadDimensionId = dimensions[index].stableId;
  };

  visit(0, { score: 0, usedKeys: new Set(), selected: [] });
  return { best, visitedStates, firstDeadDimensionId, discarded: 0 };
}

function seedFrontierSearch<T>(
  dimensions: readonly IndexedDimension<T>[],
  isCompleteSelectionFeasible?: (options: readonly IndexedOption<T>[]) => boolean
) {
  const ordered = [...dimensions].sort((left, right) =>
    left.options.length - right.options.length || compareCodePoints(left.stableId, right.stableId)
  );
  let states: SearchState<T>[] = [{ score: 0, usedKeys: new Set(), selected: [] }];
  let visitedStates = 0;
  let discarded = 0;
  let firstDeadDimensionId: string | undefined;
  for (const dimension of ordered) {
    const nextByFutureBehavior = new Map<string, SearchState<T>>();
    for (const state of states) {
      for (const candidate of dimension.options) {
        visitedStates += 1;
        if (candidate.keys.some((key) => state.usedKeys.has(key))) continue;
        const next: SearchState<T> = {
          score: state.score + candidate.score,
          usedKeys: new Set([...state.usedKeys, ...candidate.keys]),
          selected: [...state.selected, candidate]
        };
        const signature = [...next.usedKeys].sort(compareCodePoints).join("\u0000");
        const equivalent = nextByFutureBehavior.get(signature);
        if (!equivalent || compareStates(next, equivalent) < 0) nextByFutureBehavior.set(signature, next);
      }
    }
    const next = [...nextByFutureBehavior.values()].sort(compareStates);
    if (next.length === 0) {
      firstDeadDimensionId = dimension.stableId;
      states = [];
      break;
    }
    if (next.length > largeSeedFrontierSize) discarded += next.length - largeSeedFrontierSize;
    states = next.slice(0, largeSeedFrontierSize);
  }
  const best = states.find((state) => !isCompleteSelectionFeasible || isCompleteSelectionFeasible(state.selected));
  if (!best) return { best, visitedStates, firstDeadDimensionId, discarded };
  const selectedByDimension = new Map(ordered.map((dimension, index) => [dimension.stableId, best.selected[index]]));
  return {
    best: { ...best, selected: dimensions.map((dimension) => selectedByDimension.get(dimension.stableId)!) },
    visitedStates,
    firstDeadDimensionId,
    discarded
  };
}

function feasibilityFirstSearch<T>(
  dimensions: readonly IndexedDimension<T>[],
  isCompleteSelectionFeasible?: (options: readonly IndexedOption<T>[]) => boolean
) {
  const ordered = [...dimensions].sort((left, right) =>
    left.options.length - right.options.length || compareCodePoints(left.stableId, right.stableId)
  );
  const keyCountsByDimension = new Map<string, Map<string, number>>();
  for (const dimension of ordered) {
    for (const candidate of dimension.options) {
      for (const key of candidate.keys) {
        const byDimension = keyCountsByDimension.get(key) ?? new Map<string, number>();
        byDimension.set(dimension.stableId, (byDimension.get(dimension.stableId) ?? 0) + 1);
        keyCountsByDimension.set(key, byDimension);
      }
    }
  }
  const leastConstrainingOptions = new Map(ordered.map((dimension) => {
    const blockingCount = (candidate: IndexedOption<T>) => candidate.keys.reduce((sum, key) => {
      const byDimension = keyCountsByDimension.get(key);
      if (!byDimension) return sum;
      return sum + [...byDimension.entries()].reduce(
        (inner, [dimensionId, count]) => inner + (dimensionId === dimension.stableId ? 0 : count),
        0
      );
    }, 0);
    return [dimension.stableId, [...dimension.options].sort((left, right) =>
      blockingCount(left) - blockingCount(right) || compareOptions(left, right)
    )] as const;
  }));
  let visitedStates = 0;
  let budgetExhausted = false;
  let firstDeadDimensionId: string | undefined;
  let witness: Array<{ dimensionId: string; option: IndexedOption<T> }> | undefined;
  const selected: Array<{ dimensionId: string; option: IndexedOption<T> }> = [];

  const visit = (index: number, usedKeys: Set<string>): boolean => {
    if (index === ordered.length) {
      const canonical = new Map(selected.map(({ dimensionId, option }) => [dimensionId, option]));
      const options = dimensions.map((dimension) => canonical.get(dimension.stableId)!);
      if (!isCompleteSelectionFeasible || isCompleteSelectionFeasible(options)) {
        witness = [...selected];
        return true;
      }
      return false;
    }
    const dimension = ordered[index];
    let expanded = false;
    for (const candidate of leastConstrainingOptions.get(dimension.stableId) ?? []) {
      if (visitedStates >= feasibilityWorkBudget) {
        budgetExhausted = true;
        return false;
      }
      visitedStates += 1;
      if (candidate.keys.some((key) => usedKeys.has(key))) continue;
      expanded = true;
      const nextUsedKeys = new Set(usedKeys);
      candidate.keys.forEach((key) => nextUsedKeys.add(key));
      selected.push({ dimensionId: dimension.stableId, option: candidate });
      if (visit(index + 1, nextUsedKeys)) return true;
      selected.pop();
      if (budgetExhausted) return false;
    }
    if (!expanded && firstDeadDimensionId === undefined) firstDeadDimensionId = dimension.stableId;
    return false;
  };

  visit(0, new Set());
  const selectedByDimension = new Map(witness?.map(({ dimensionId, option }) => [dimensionId, option]));
  const canonicalWitness = witness
    ? dimensions.map((dimension) => selectedByDimension.get(dimension.stableId)!)
    : undefined;
  return { witness: canonicalWitness, visitedStates, budgetExhausted, firstDeadDimensionId };
}

function completeScoreSearch<T>(
  dimensions: readonly IndexedDimension<T>[],
  initialCandidates: readonly (readonly IndexedOption<T>[] | undefined)[],
  isCompleteSelectionFeasible?: (options: readonly IndexedOption<T>[]) => boolean
) {
  let visitedStates = 0;
  let workUnits = 0;
  let budgetExhausted = false;
  let firstDeadDimensionId: string | undefined;
  let best: SearchState<T> | undefined;
  for (const selected of initialCandidates) {
    if (!selected || selected.length !== dimensions.length ||
        isCompleteSelectionFeasible && !isCompleteSelectionFeasible(selected)) continue;
    const state: SearchState<T> = {
      score: selected.reduce((sum, candidate) => sum + candidate.score, 0),
      usedKeys: new Set(selected.flatMap((candidate) => candidate.keys)),
      selected
    };
    if (!best || compareStates(state, best) < 0) best = state;
  }

  const outOfBudget = () => {
    if (workUnits >= optimizationWorkBudget) {
      budgetExhausted = true;
      return true;
    }
    return false;
  };
  const compatibleOptions = (dimension: IndexedDimension<T>, usedKeys: ReadonlySet<string>) => {
    const compatible: IndexedOption<T>[] = [];
    for (const candidate of dimension.options) {
      if (outOfBudget()) break;
      workUnits += 1;
      if (!candidate.keys.some((key) => usedKeys.has(key))) compatible.push(candidate);
    }
    return compatible;
  };
  const chooseNextDimension = (
    remaining: readonly IndexedDimension<T>[],
    usedKeys: ReadonlySet<string>
  ) => {
    let selectedDimension: IndexedDimension<T> | undefined;
    let selectedCompatible: IndexedOption<T>[] = [];
    for (const dimension of remaining) {
      const compatible = compatibleOptions(dimension, usedKeys);
      if (compatible.length === 0) return { deadDimension: dimension };
      if (!selectedDimension ||
          dimensionHasScoredOptions(dimension) && !dimensionHasScoredOptions(selectedDimension) ||
          dimensionHasScoredOptions(dimension) === dimensionHasScoredOptions(selectedDimension) &&
          (compatible.length < selectedCompatible.length ||
          compatible.length === selectedCompatible.length &&
          compareCodePoints(dimension.stableId, selectedDimension.stableId) < 0)) {
        selectedDimension = dimension;
        selectedCompatible = compatible;
      }
    }
    return { selectedDimension: selectedDimension!, selectedCompatible };
  };
  const candidateUpperBound = (
    candidate: IndexedOption<T>,
    remaining: readonly IndexedDimension<T>[],
    usedKeys: ReadonlySet<string>,
    score: number
  ) => {
    const nextUsedKeys = new Set(usedKeys);
    candidate.keys.forEach((key) => nextUsedKeys.add(key));
    let upperBound = score + candidate.score;
    for (const dimension of remaining) {
      let compatible: IndexedOption<T> | undefined;
      for (const option of dimension.options) {
        if (outOfBudget()) break;
        workUnits += 1;
        if (!option.keys.some((key) => nextUsedKeys.has(key))) {
          compatible = option;
          break;
        }
      }
      if (!compatible) return Number.NEGATIVE_INFINITY;
      upperBound += compatible.score;
    }
    return upperBound;
  };

  // Establish a useful score-first incumbent before the bounded proof search.
  // MRV and per-candidate forward checking keep high-scoring dead ends cheap.
  const incumbentSelected = new Map<string, IndexedOption<T>>();
  const incumbentPhaseOver = () => visitedStates >= incumbentWorkBudget || outOfBudget();
  const findIncumbent = (
    remaining: readonly IndexedDimension<T>[],
    usedKeys: ReadonlySet<string>,
    score: number
  ): boolean => {
    if (incumbentPhaseOver()) return false;
    if (remaining.length === 0) {
      const selected = dimensions.map((dimension) => incumbentSelected.get(dimension.stableId)!);
      if (isCompleteSelectionFeasible && !isCompleteSelectionFeasible(selected)) return false;
      const state: SearchState<T> = { score, usedKeys, selected };
      if (!best || compareStates(state, best) < 0) best = state;
      return true;
    }
    const choice = chooseNextDimension(remaining, usedKeys);
    if (choice.deadDimension) {
      if (firstDeadDimensionId === undefined) firstDeadDimensionId = choice.deadDimension.stableId;
      return false;
    }
    const nextRemaining = remaining.filter((dimension) => dimension !== choice.selectedDimension);
    for (const candidate of choice.selectedCompatible) {
      if (incumbentPhaseOver()) return false;
      if (candidateUpperBound(candidate, nextRemaining, usedKeys, score) === Number.NEGATIVE_INFINITY) continue;
      visitedStates += 1;
      const nextUsedKeys = new Set(usedKeys);
      candidate.keys.forEach((key) => nextUsedKeys.add(key));
      incumbentSelected.set(choice.selectedDimension.stableId, candidate);
      if (findIncumbent(nextRemaining, nextUsedKeys, score + candidate.score)) return true;
      incumbentSelected.delete(choice.selectedDimension.stableId);
    }
    return false;
  };
  const firstChoice = chooseNextDimension(dimensions, new Set());
  if (firstChoice.selectedDimension) {
    const nextRemaining = dimensions.filter((dimension) => dimension !== firstChoice.selectedDimension);
    for (const candidate of firstChoice.selectedCompatible) {
      if (incumbentPhaseOver()) break;
      if (candidateUpperBound(candidate, nextRemaining, new Set(), 0) === Number.NEGATIVE_INFINITY) continue;
      visitedStates += 1;
      incumbentSelected.set(firstChoice.selectedDimension.stableId, candidate);
      findIncumbent(nextRemaining, new Set(candidate.keys), candidate.score);
      incumbentSelected.delete(firstChoice.selectedDimension.stableId);
    }
  }

  const visit = (
    remaining: readonly IndexedDimension<T>[],
    usedKeys: ReadonlySet<string>,
    selectedByDimension: ReadonlyMap<string, IndexedOption<T>>,
    score: number
  ) => {
    if (outOfBudget()) return;
    if (remaining.length === 0) {
      const selected = dimensions.map((dimension) => selectedByDimension.get(dimension.stableId)!);
      if (isCompleteSelectionFeasible && !isCompleteSelectionFeasible(selected)) return;
      const state: SearchState<T> = { score, usedKeys, selected };
      if (!best || compareStates(state, best) < 0) best = state;
      return;
    }

    const choice = chooseNextDimension(remaining, usedKeys);
    if (choice.deadDimension) {
      if (firstDeadDimensionId === undefined) firstDeadDimensionId = choice.deadDimension.stableId;
      return;
    }
    const { selectedDimension, selectedCompatible } = choice;
    let upperBound = score;
    for (const dimension of remaining) {
      const compatible = compatibleOptions(dimension, usedKeys)[0];
      if (!compatible) return;
      upperBound += compatible.score;
    }
    if (best && upperBound < best.score) return;

    const nextRemaining = remaining.filter((dimension) => dimension !== selectedDimension);
    const prioritized = selectedCompatible.map((candidate) => ({
      candidate,
      upperBound: candidateUpperBound(candidate, nextRemaining, usedKeys, score)
    })).sort((left, right) =>
      right.upperBound - left.upperBound || compareOptions(left.candidate, right.candidate)
    );
    for (const { candidate, upperBound: candidateUpperBound } of prioritized) {
      if (outOfBudget()) return;
      if (best && candidateUpperBound < best.score) continue;
      visitedStates += 1;
      const nextUsedKeys = new Set(usedKeys);
      candidate.keys.forEach((key) => nextUsedKeys.add(key));
      const nextSelected = new Map(selectedByDimension);
      nextSelected.set(selectedDimension!.stableId, candidate);
      visit(nextRemaining, nextUsedKeys, nextSelected, score + candidate.score);
      if (budgetExhausted) return;
    }
  };

  visit(dimensions, new Set(), new Map(), 0);
  return { best, visitedStates, budgetExhausted, firstDeadDimensionId };
}

export function searchBestConflictFreeOptions<T>(
  inputDimensions: readonly ConflictFreeSearchDimension<T>[],
  constraints: ConflictFreeSearchConstraints<T> = {}
): ConflictFreeSearchResult<T> {
  const normalized = normalizeDimensions(inputDimensions);
  const completeSelectionEvaluationBudget = constraints.completeSelectionEvaluationBudget ??
    defaultCompleteSelectionEvaluationBudget;
  const completeSelectionResults = new Map<string, boolean>();
  let completeSelectionEvaluations = 0;
  let completeSelectionBudgetExhausted = false;
  const evaluateCompleteSelection = constraints.isCompleteSelectionFeasible
    ? (options: readonly IndexedOption<T>[]) => {
        const signature = options.map(optionSignature).sort(compareCodePoints).join("|");
        const cached = completeSelectionResults.get(signature);
        if (cached !== undefined) return cached;
        if (completeSelectionEvaluations >= completeSelectionEvaluationBudget) {
          completeSelectionBudgetExhausted = true;
          return false;
        }
        completeSelectionEvaluations += 1;
        const result = constraints.isCompleteSelectionFeasible!(options);
        completeSelectionResults.set(signature, result);
        return result;
      }
    : undefined;
  const explicitlyIncomplete = normalized
    .filter((dimension) => dimension.required && !dimension.options.some((option) => option.fillsDimension !== false))
    .map((dimension) => dimension.stableId);
  if (explicitlyIncomplete.length > 0) {
    return {
      options: [],
      diagnostic: {
        optimality: "certified",
        completion: "infeasible",
        visitedStates: 0,
        discardedStates: 0,
        feasibilityVisitedStates: 0,
        feasibilityWorkBudget,
        feasibilityBudgetExhausted: false,
        optimizationVisitedStates: 0,
        optimizationWorkBudget,
        optimizationBudgetExhausted: false,
        incompleteDimensionIds: explicitlyIncomplete
      }
    };
  }

  const fillable = normalized.map((dimension) => ({
    ...dimension,
    options: dimension.required
      ? dimension.options.filter((option) => option.fillsDimension !== false)
      : dimension.options
  }));
  const prefrontier = buildPrefrontier(fillable);
  const combinationCount = prefrontier.dimensions.reduce(
    (product, dimension) => Math.min(product * Math.max(dimension.options.length, 1), exactCombinationLimit + 1),
    1
  );
  if (prefrontier.discarded === 0 && combinationCount <= exactCombinationLimit) {
    const searched = exhaustiveSearch(fillable, evaluateCompleteSelection);
    const completion = searched.best?.selected.length === normalized.length
      ? "complete" as const
      : completeSelectionBudgetExhausted ? "unknown" as const : "infeasible" as const;
    return {
      options: completion === "complete" ? searched.best!.selected : [],
      diagnostic: {
        optimality: completeSelectionBudgetExhausted ? "not-certified" : "certified",
        ...(completeSelectionBudgetExhausted ? { limitation: "optimization-budget-limited" as const } : {}),
        completion,
        visitedStates: searched.visitedStates,
        discardedStates: 0,
        feasibilityVisitedStates: 0,
        feasibilityWorkBudget,
        feasibilityBudgetExhausted: false,
        optimizationVisitedStates: 0,
        optimizationWorkBudget,
        optimizationBudgetExhausted: completeSelectionBudgetExhausted,
        incompleteDimensionIds: completion === "complete"
          ? []
          : searched.firstDeadDimensionId ? [searched.firstDeadDimensionId] : normalized.map(({ stableId }) => stableId)
      }
    };
  }

  // This phase proves only conflict feasibility. Complete-selection constraints
  // can be mechanically expensive and are applied to the deterministic score
  // frontier and bounded optimization below.
  const feasible = feasibilityFirstSearch(fillable);
  if (!feasible.witness && !feasible.budgetExhausted) {
    return {
      options: [],
      diagnostic: {
        optimality: "certified",
        completion: "infeasible",
        visitedStates: feasible.visitedStates,
        discardedStates: 0,
        feasibilityVisitedStates: feasible.visitedStates,
        feasibilityWorkBudget,
        feasibilityBudgetExhausted: false,
        optimizationVisitedStates: 0,
        optimizationWorkBudget,
        optimizationBudgetExhausted: false,
        incompleteDimensionIds: feasible.firstDeadDimensionId
          ? [feasible.firstDeadDimensionId]
          : normalized.map(({ stableId }) => stableId)
      }
    };
  }

  // A wide score beam is expensive and still incomplete on large conflict
  // products. Keep only a small deterministic seed frontier; proof/improvement
  // work below still uses every fillable option.
  const searched = combinationCount <= exactCombinationLimit
    ? exhaustiveSearch(prefrontier.dimensions, evaluateCompleteSelection)
    : seedFrontierSearch(prefrontier.dimensions, evaluateCompleteSelection);
  const frontierComplete = searched.best?.selected.length === normalized.length;
  const optimized = completeScoreSearch(fillable, [
    feasible.witness,
    frontierComplete ? searched.best!.selected : undefined
  ], evaluateCompleteSelection);
  const selected = optimized.best?.selected;
  const completion = selected ? "complete" as const : "unknown" as const;
  const discardedStates = prefrontier.discarded + searched.discarded;
  const limitation = optimized.budgetExhausted || completeSelectionBudgetExhausted
    ? "optimization-budget-limited" as const
    : feasible.budgetExhausted && !selected
    ? "feasibility-budget-limited" as const
    : searched.discarded > 0
      ? "frontier-limited" as const
      : prefrontier.discarded > 0
        ? "prefrontier-limited" as const
        : undefined;
  return {
    options: selected ?? [],
    diagnostic: {
      optimality: discardedStates === 0 && completion !== "unknown" && !optimized.budgetExhausted &&
        !completeSelectionBudgetExhausted
        ? "certified"
        : "not-certified",
      ...(limitation ? { limitation } : {}),
      completion,
      visitedStates: feasible.visitedStates + searched.visitedStates + optimized.visitedStates,
      discardedStates,
      feasibilityVisitedStates: feasible.visitedStates,
      feasibilityWorkBudget,
      feasibilityBudgetExhausted: feasible.budgetExhausted,
      optimizationVisitedStates: optimized.visitedStates,
      optimizationWorkBudget,
      optimizationBudgetExhausted: optimized.budgetExhausted || completeSelectionBudgetExhausted,
      incompleteDimensionIds: completion === "complete"
        ? []
        : optimized.firstDeadDimensionId
          ? [optimized.firstDeadDimensionId]
          : searched.firstDeadDimensionId
          ? [searched.firstDeadDimensionId]
          : feasible.firstDeadDimensionId
            ? [feasible.firstDeadDimensionId]
            : normalized.map(({ stableId }) => stableId)
    }
  };
}

export function selectBestConflictFreeOptions<T>(
  dimensions: readonly ConflictFreeSearchDimension<T>[]
): readonly ConflictFreeSearchOption<T>[] {
  return searchBestConflictFreeOptions(dimensions).options;
}
