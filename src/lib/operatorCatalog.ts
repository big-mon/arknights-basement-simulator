import { languageLocale, localizedTextValues, localizeText } from "./localization";
import type { LanguageCode, Operator, OperatorProfession, RosterEntry } from "../types";

const professionOrder: OperatorProfession[] = ["先鋒", "前衛", "重装", "狙撃", "術師", "医療", "補助", "特殊", "その他"];

export function getProfessions(operatorList: Operator[]): OperatorProfession[] {
  return Array.from(new Set(operatorList.map((operator) => operator.profession))).sort(
    (a, b) => professionSortIndex(a) - professionSortIndex(b)
  );
}

export function getRarities(operatorList: Operator[]): Array<Operator["rarity"]> {
  return Array.from(new Set(operatorList.map((operator) => operator.rarity))).sort((a, b) => b - a);
}

export function filterOperators(
  operatorList: Operator[],
  query: string,
  professionFilter: string,
  rarityFilter: "all" | string
): Operator[] {
  const normalizedQuery = query.toLowerCase();

  return operatorList.filter((operator) => {
    const operatorSearchText = [operator.id, ...localizedTextValues(operator.name)].join(" ").toLowerCase();
    const matchesQuery = operatorSearchText.includes(normalizedQuery);
    const matchesProfession = professionFilter === "all" || operator.profession === professionFilter;
    const matchesRarity = rarityFilter === "all" || operator.rarity === Number(rarityFilter);
    return matchesQuery && matchesProfession && matchesRarity;
  });
}

export function groupOperatorsByProfessionAndRarity(
  operatorList: Operator[],
  roster: Record<string, RosterEntry>,
  language: LanguageCode
) {
  return getProfessions(operatorList).map((profession) => {
    const professionOperators = operatorList.filter((operator) => operator.profession === profession);
    const ownedTotal = countOwnedOperators(professionOperators, roster);

    return {
      profession,
      total: professionOperators.length,
      ownedTotal,
      rarityGroups: getRarities(professionOperators).map((rarity) => {
        const rarityOperators = professionOperators
          .filter((operator) => operator.rarity === rarity)
          .sort((a, b) => localizeText(a.name, language).localeCompare(localizeText(b.name, language), languageLocale(language)));

        return {
          rarity,
          ownedTotal: countOwnedOperators(rarityOperators, roster),
          operators: rarityOperators
        };
      })
    };
  });
}

export function countOwnedOperators(operatorList: Operator[], roster: Record<string, RosterEntry>): number {
  return operatorList.filter((operator) => roster[operator.id]?.owned).length;
}

export function operatorNameById(operatorList: Operator[], operatorId: string, language: LanguageCode): string {
  const operator = operatorList.find((candidate) => candidate.id === operatorId);
  return operator ? localizeText(operator.name, language) : operatorId;
}

export function rarityGroupKey(profession: string, rarity: number): string {
  return `${profession}-${rarity}`;
}

function professionSortIndex(profession: OperatorProfession): number {
  const index = professionOrder.indexOf(profession);
  return index === -1 ? professionOrder.length : index;
}
