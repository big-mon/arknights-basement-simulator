import type { MouseEvent } from "react";
import { facilityLabels, productLabels, professionLabels, uiText } from "../i18n";
import { localizeText } from "../lib/localization";
import type { LanguageCode, Operator, RosterEntry } from "../types";

export function OperatorCard({
  operator,
  entry,
  language,
  onUpdateRoster
}: {
  operator: Operator;
  entry: RosterEntry;
  language: LanguageCode;
  onUpdateRoster: (operatorId: string, patch: Partial<RosterEntry>) => void;
}) {
  const unlockedSkills = operator.skills.filter((skill) => skill.unlockPhase <= entry.elite).length;
  const text = uiText[language];
  const operatorName = localizeText(operator.name, language);

  function toggleOwnedFromCard(event: MouseEvent<HTMLElement>) {
    if (isInteractiveCardTarget(event.target)) {
      return;
    }

    onUpdateRoster(operator.id, { owned: !entry.owned });
  }

  return (
    <article className={entry.owned ? "operator-card owned" : "operator-card"} onClick={toggleOwnedFromCard}>
      <div className="operator-card-top">
        <div className="operator-card-main">
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={entry.owned}
              onChange={(event) => onUpdateRoster(operator.id, { owned: event.target.checked })}
            />
            <span>{operatorName}</span>
          </label>
          <p>
            {`★${operator.rarity} / ${professionLabels[language][operator.profession]} / ${text.roster.baseSkill} ${unlockedSkills}/${operator.skills.length}`}
          </p>
        </div>
        <div className="operator-controls">
          <label>
            {text.roster.elite}
            <select
              value={entry.elite}
              onChange={(event) => onUpdateRoster(operator.id, { elite: Number(event.target.value) as 0 | 1 | 2 })}
            >
              <option value={0}>0</option>
              <option value={1}>1</option>
              <option value={2}>2</option>
            </select>
          </label>
        </div>
      </div>
      <ul className="base-skill-list" aria-label={text.roster.skillListLabel(operatorName)}>
        {operator.skills.map((skill) => {
          const unlocked = skill.unlockPhase <= entry.elite;
          const skillName = localizeText(skill.name, language);
          return (
            <li key={skill.id} className={unlocked ? "base-skill unlocked" : "base-skill locked"}>
              <div className="base-skill-heading">
                <strong>{skillName}</strong>
                <span>{unlocked ? text.roster.unlocked : text.roster.unlockAtElite(skill.unlockPhase)}</span>
              </div>
              {skill.effects.map((effect, index) => (
                <p key={`${skill.id}-${index}`}>
                  {facilityLabels[language][effect.facility]}
                  {effect.product ? ` / ${productLabels[language][effect.product]}` : ""}:{" "}
                  {localizeText(effect.description, language)}
                </p>
              ))}
            </li>
          );
        })}
      </ul>
    </article>
  );
}

function isInteractiveCardTarget(target: EventTarget) {
  return target instanceof Element && Boolean(target.closest("button, input, label, select, textarea, a"));
}
