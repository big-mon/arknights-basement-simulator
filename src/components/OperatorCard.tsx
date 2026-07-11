import type { MouseEvent } from "react";
import { CircleHelp } from "lucide-react";
import { facilityLabels, productLabels, professionLabels, uiText } from "../i18n";
import { clampEliteForOperator, eliteOptionsForOperator } from "../lib/elite";
import { hasLocalizedText, localizeText } from "../lib/localization";
import { effectiveLevelForOperator, levelOptionsForOperator } from "../lib/operatorLevel";
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
  const elite = clampEliteForOperator(operator, entry.elite);
  const levelOptions = levelOptionsForOperator(operator);
  const effectiveLevel = effectiveLevelForOperator(operator, entry.level);
  const text = uiText[language];
  const operatorName = localizeText(operator.name, language);
  const missingSelectedLanguageName = !hasLocalizedText(operator.name, language);
  const ignoredOptimizationLabel = ignoredOptimizationLabels[language];

  function toggleOwnedFromCard(event: MouseEvent<HTMLElement>) {
    if (isInteractiveCardTarget(event.target)) {
      return;
    }

    onUpdateRoster(operator.id, { owned: !entry.owned });
  }

  return (
    <article className={entry.owned ? "operator-card owned" : "operator-card"} onClick={toggleOwnedFromCard}>
      <div className="operator-card-top">
        <div className="operator-identity">
          <img
            className="operator-avatar"
            src={`/operator-avatars/${operator.id}.png`}
            alt={`${operatorName} icon`}
            loading="lazy"
            onError={(event) => {
              event.currentTarget.hidden = true;
            }}
          />
          <div className="operator-card-main">
            <div className="operator-name-line">
              <label className="checkbox-line">
                <input
                  type="checkbox"
                  checked={entry.owned}
                  onChange={(event) => onUpdateRoster(operator.id, { owned: event.target.checked })}
                />
                <span>{operatorName}</span>
              </label>
              {missingSelectedLanguageName ? (
                <span
                  className="localization-warning"
                  role="img"
                  aria-label={text.roster.missingLocalizedName}
                  title={text.roster.missingLocalizedName}
                >
                  <CircleHelp size={16} />
                </span>
              ) : null}
            </div>
            <p>{`★${operator.rarity} / ${professionLabels[language][operator.profession]}`}</p>
          </div>
        </div>
        <div className="operator-controls">
          <label>
            {text.roster.elite}
            <select
              value={elite}
              onChange={(event) => onUpdateRoster(operator.id, { elite: Number(event.target.value) as 0 | 1 | 2 })}
            >
              {eliteOptionsForOperator(operator).map((eliteOption) => (
                <option key={eliteOption} value={eliteOption}>
                  {eliteOption}
                </option>
              ))}
            </select>
          </label>
          {levelOptions.length ? (
            <label>
              {levelLabels[language]}
              <select
                value={effectiveLevel}
                onChange={(event) => onUpdateRoster(operator.id, { level: Number(event.target.value) })}
              >
                {levelOptions.map((levelOption) => (
                  <option key={levelOption} value={levelOption}>
                    {levelOption}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </div>
      <ul className="base-skill-list" aria-label={text.roster.skillListLabel(operatorName)}>
        {operator.skills.map((skill) => {
          const unlocked = skill.unlockPhase < elite || (skill.unlockPhase === elite && skill.unlockLevel <= entry.level);
          const skillName = localizeText(skill.name, language);
          const missingSkillName = !hasLocalizedText(skill.name, language);
          return (
            <li key={skill.id} className={unlocked ? "base-skill unlocked" : "base-skill locked"}>
              <div className="base-skill-heading">
                <strong>{skillName}</strong>
                {missingSkillName ? (
                  <span
                    className="localization-warning"
                    role="img"
                    aria-label={text.roster.missingLocalizedSkill}
                    title={text.roster.missingLocalizedSkill}
                  >
                    <CircleHelp size={14} />
                  </span>
                ) : null}
                <span>{unlocked ? text.roster.unlocked : unlockRequirementLabel(language, skill.unlockPhase, skill.unlockLevel)}</span>
              </div>
              {skill.effects
                .filter((effect) => !effect.hiddenFromUi)
                .map((effect, index) => (
                  <p key={`${skill.id}-${index}`}>
                    {facilityLabels[language][effect.facility]}
                    {effect.product ? ` / ${productLabels[language][effect.product]}` : ""}:{" "}
                    {localizeText(effect.description, language)}
                    {!hasLocalizedText(effect.description, language) ? (
                      <span
                        className="localization-warning"
                        role="img"
                        aria-label={text.roster.missingLocalizedSkill}
                        title={text.roster.missingLocalizedSkill}
                      >
                        <CircleHelp size={14} />
                      </span>
                    ) : null}
                    {effect.ignoredForOptimization ? <span className="optimization-note">{ignoredOptimizationLabel}</span> : null}
                  </p>
                ))}
            </li>
          );
        })}
      </ul>
    </article>
  );
}

const ignoredOptimizationLabels: Record<LanguageCode, string> = {
  ja: "最適化計算対象外",
  zh: "不参与优化计算",
  en: "Excluded from optimization"
};

const levelLabels: Record<LanguageCode, string> = {
  ja: "レベル",
  zh: "等级",
  en: "Level"
};

function unlockRequirementLabel(language: LanguageCode, phase: number, level: number) {
  if (language === "ja") return `昇進${phase} Lv.${level}で解放`;
  if (language === "zh") return `精英化${phase} Lv.${level}解锁`;
  return `Unlocks at E${phase} Lv.${level}`;
}

function isInteractiveCardTarget(target: EventTarget) {
  return target instanceof Element && Boolean(target.closest("button, input, label, select, textarea, a"));
}
