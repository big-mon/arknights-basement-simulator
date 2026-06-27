import { ChangeEvent, MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Languages,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Upload,
  Users
} from "lucide-react";
import {
  createDefaultState,
  createFacilitiesForLayout,
  defaultLayout,
  isBaseLayout,
  layoutPresets,
  operators
} from "./data/defaults";
import {
  facilityLabels,
  languageOptions,
  layoutLabels,
  preferenceLabels,
  productLabels,
  professionLabels,
  uiText
} from "./i18n";
import { generateAssignmentPlan } from "./lib/optimizer";
import { exportState, importState, loadState, saveState } from "./lib/storage";
import type {
  AppState,
  BaseLayout,
  FacilitySlot,
  FacilityPlan,
  Assignment,
  LanguageCode,
  Operator,
  OperatorProfession,
  RosterEntry,
  RotationCount
} from "./types";

type TabId = "roster" | "plan";
type RarityFilter = "all" | `${Operator["rarity"]}`;

const tabs: Array<{ id: TabId; icon: typeof Users }> = [
  { id: "roster", icon: Users },
  { id: "plan", icon: Activity }
];

const professionOrder: OperatorProfession[] = ["先鋒", "前衛", "重装", "狙撃", "術師", "医療", "補助", "特殊", "その他"];

const preferencePresets = [
  {
    id: "balanced",
    preference: { gold: 0.35, battleRecord: 0.35, lmd: 0.3 }
  },
  {
    id: "gold",
    preference: { gold: 0.7, battleRecord: 0.15, lmd: 0.15 }
  },
  {
    id: "battleRecord",
    preference: { gold: 0.15, battleRecord: 0.7, lmd: 0.15 }
  },
  {
    id: "lmd",
    preference: { gold: 0.15, battleRecord: 0.15, lmd: 0.7 }
  }
] as const;

type PreferencePresetId = (typeof preferencePresets)[number]["id"];

export function App() {
  const [state, setState] = useState<AppState>(() => loadState());
  const [activeTab, setActiveTab] = useState<TabId>("roster");
  const [query, setQuery] = useState("");
  const [professionFilter, setProfessionFilter] = useState("all");
  const [rarityFilter, setRarityFilter] = useState<RarityFilter>("all");
  const [collapsedProfessions, setCollapsedProfessions] = useState<Set<string>>(() => new Set());
  const [collapsedRarityGroups, setCollapsedRarityGroups] = useState<Set<string>>(() => new Set());
  const [notice, setNotice] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    saveState(state);
  }, [state]);

  const plan = useMemo(() => generateAssignmentPlan(state), [state]);
  const selectedLayout = isBaseLayout(state.layout) ? state.layout : defaultLayout;
  const selectedRotationCount = state.rotationCount === 2 ? 2 : 2;
  const ownedCount = Object.values(state.roster).filter((entry) => entry.owned).length;
  const language = state.language;
  const text = uiText[language];
  const professions = Array.from(new Set(operators.map((operator) => operator.profession))).sort(
    (a, b) => professionSortIndex(a) - professionSortIndex(b)
  );
  const rarities = Array.from(new Set(operators.map((operator) => operator.rarity))).sort((a, b) => b - a);

  const filteredOperators = operators.filter((operator) => {
    const matchesQuery = `${operator.name} ${operator.id}`.toLowerCase().includes(query.toLowerCase());
    const matchesProfession = professionFilter === "all" || operator.profession === professionFilter;
    const matchesRarity = rarityFilter === "all" || operator.rarity === Number(rarityFilter);
    return matchesQuery && matchesProfession && matchesRarity;
  });
  const groupedOperators = groupOperatorsByProfessionAndRarity(filteredOperators, state.roster);

  function updateRoster(operatorId: string, patch: Partial<RosterEntry>) {
    setState((current) => ({
      ...current,
      roster: {
        ...current.roster,
        [operatorId]: {
          ...current.roster[operatorId],
          ...patch
        }
      }
    }));
  }

  function updateLanguage(language: LanguageCode) {
    setState((current) => ({
      ...current,
      language
    }));
  }

  function toggleProfession(profession: string) {
    setCollapsedProfessions((current) => toggleSetValue(current, profession));
  }

  function toggleRarityGroup(profession: string, rarity: number) {
    setCollapsedRarityGroups((current) => toggleSetValue(current, rarityGroupKey(profession, rarity)));
  }

  function updateLayout(layout: BaseLayout) {
    setState((current) => ({
      ...current,
      layout,
      facilities: createFacilitiesForLayout(layout, current.facilities)
    }));
  }

  function updatePreferencePreset(presetId: PreferencePresetId) {
    const preset = preferencePresets.find((preferencePreset) => preferencePreset.id === presetId);
    if (!preset) {
      return;
    }

    setState((current) => ({
      ...current,
      preference: preset.preference
    }));
  }

  function updateRotationCount(rotationCount: RotationCount) {
    setState((current) => ({
      ...current,
      rotationCount
    }));
  }

  function downloadJson() {
    const blob = new Blob([exportState(state)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "arknights-basement-roster.json";
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice(text.notices.exported);
  }

  async function importJson(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      setState(importState(await file.text()));
      setNotice(text.notices.imported);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : text.notices.importFailed);
    } finally {
      event.target.value = "";
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">ARKNIGHTS BASEMENT</p>
          <h1>{text.appTitle}</h1>
        </div>
        <div className="toolbar" aria-label={text.toolbarLabel}>
          <label className="language-selector">
            <Languages size={18} />
            <span>{text.language}</span>
            <select value={language} onChange={(event) => updateLanguage(event.target.value as LanguageCode)}>
              {languageOptions.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="icon-button" onClick={downloadJson} title={text.exportJson}>
            <Download size={18} />
          </button>
          <button type="button" className="icon-button" onClick={() => fileInputRef.current?.click()} title={text.importJson}>
            <Upload size={18} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => setState((current) => ({ ...createDefaultState(), language: current.language }))}
            title={text.reset}
          >
            <RotateCcw size={18} />
          </button>
          <input ref={fileInputRef} className="sr-only" type="file" accept="application/json" onChange={importJson} />
        </div>
      </header>

      <section className="summary-strip" aria-label={text.summaryLabel}>
        <Stat icon={Users} label={text.stats.owned} value={`${ownedCount}/${operators.length}`} />
        <label className="summary-control layout-summary-control">
          <span className="summary-control-label">{text.plan.baseLayout}</span>
          <select
            className="layout-select"
            value={selectedLayout}
            onChange={(event) => {
              if (isBaseLayout(event.target.value)) {
                updateLayout(event.target.value);
              }
            }}
          >
            {(Object.keys(layoutPresets) as BaseLayout[]).map((layout) => (
              <option key={layout} value={layout}>
                {layoutLabels[language][layout].label} ({layoutLabels[language][layout].description})
              </option>
            ))}
          </select>
        </label>
        <div className="summary-control">
          <span className="summary-control-label">{text.plan.rotationCount}</span>
          <div className="rotation-selector compact" aria-label={text.plan.rotationCount}>
            <button
              type="button"
              className={selectedRotationCount === 2 ? "rotation-option active" : "rotation-option"}
              aria-pressed={selectedRotationCount === 2}
              onClick={() => updateRotationCount(2)}
            >
              <Check size={16} />
              <span>{text.plan.rotationOption(2)}</span>
              <small>{text.plan.selected}</small>
            </button>
            <button
              type="button"
              className={state.rotationCount === 3 ? "rotation-option active" : "rotation-option"}
              aria-pressed={state.rotationCount === 3}
              disabled
              title={text.plan.futureSupport}
            >
              {text.plan.rotationOption(3)}
              <small>{text.plan.planned}</small>
            </button>
          </div>
        </div>
      </section>

      {notice ? <p className="notice">{notice}</p> : null}

      <nav className="tabs" aria-label={text.tabsLabel}>
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              className={activeTab === tab.id ? "tab active" : "tab"}
              onClick={() => setActiveTab(tab.id)}
            >
              <Icon size={18} />
              {text.tabs[tab.id]}
            </button>
          );
        })}
      </nav>

      {activeTab === "roster" ? (
        <section className="panel" aria-labelledby="roster-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{text.roster.eyebrow}</p>
              <h2 id="roster-title">{text.roster.title}</h2>
            </div>
            <div className="filters">
              <label className="search-box">
                <Search size={17} />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text.roster.searchPlaceholder} />
              </label>
            </div>
          </div>

          <div className="roster-filter-panel" aria-label={`${text.roster.professionFilter} / ${text.roster.rarityFilter}`}>
            <fieldset className="filter-group">
              <legend>{text.roster.professionFilter}</legend>
              <div className="filter-options" role="radiogroup" aria-label={text.roster.professionFilter}>
                <label className={professionFilter === "all" ? "filter-chip active" : "filter-chip"}>
                  <input
                    type="radio"
                    name="profession-filter"
                    value="all"
                    checked={professionFilter === "all"}
                    onChange={() => setProfessionFilter("all")}
                  />
                  <span>{text.roster.allProfessions}</span>
                </label>
                {professions.map((profession) => (
                  <label key={profession} className={professionFilter === profession ? "filter-chip active" : "filter-chip"}>
                    <input
                      type="radio"
                      name="profession-filter"
                      value={profession}
                      checked={professionFilter === profession}
                      onChange={() => setProfessionFilter(profession)}
                    />
                    <span>{professionLabels[language][profession]}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="filter-group">
              <legend>{text.roster.rarityFilter}</legend>
              <div className="filter-options" role="radiogroup" aria-label={text.roster.rarityFilter}>
                <label className={rarityFilter === "all" ? "filter-chip active" : "filter-chip"}>
                  <input
                    type="radio"
                    name="rarity-filter"
                    value="all"
                    checked={rarityFilter === "all"}
                    onChange={() => setRarityFilter("all")}
                  />
                  <span>{text.roster.allRarities}</span>
                </label>
                {rarities.map((rarity) => (
                  <label key={rarity} className={rarityFilter === String(rarity) ? "filter-chip active" : "filter-chip"}>
                    <input
                      type="radio"
                      name="rarity-filter"
                      value={rarity}
                      checked={rarityFilter === String(rarity)}
                      onChange={() => setRarityFilter(String(rarity) as RarityFilter)}
                    />
                    <span>★{rarity}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>

          <div className="operator-sections">
            {groupedOperators.map((professionGroup) => {
              const professionCollapsed = collapsedProfessions.has(professionGroup.profession);

              return (
                <section key={professionGroup.profession} className="operator-profession-section">
                  <div className="operator-section-heading">
                    <h3>
                      <button
                        type="button"
                        className="collapse-toggle"
                        aria-expanded={!professionCollapsed}
                        onClick={() => toggleProfession(professionGroup.profession)}
                      >
                        {professionCollapsed ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
                        <span>{professionLabels[language][professionGroup.profession]}</span>
                        <span className="collapse-count" aria-hidden="true">
                          {formatCount(professionGroup.ownedTotal, professionGroup.total, language)}
                        </span>
                      </button>
                    </h3>
                  </div>
                  {!professionCollapsed
                    ? professionGroup.rarityGroups.map((rarityGroup) => {
                        const rarityCollapsed = collapsedRarityGroups.has(
                          rarityGroupKey(professionGroup.profession, rarityGroup.rarity)
                        );

                        return (
                          <section
                            key={`${professionGroup.profession}-${rarityGroup.rarity}`}
                            className="operator-rarity-section"
                          >
                            <div className="operator-rarity-heading">
                              <h4>
                                <button
                                  type="button"
                                  className="collapse-toggle"
                                  aria-expanded={!rarityCollapsed}
                                  onClick={() => toggleRarityGroup(professionGroup.profession, rarityGroup.rarity)}
                                >
                                  {rarityCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                                  <span>★{rarityGroup.rarity}</span>
                                  <span className="collapse-count" aria-hidden="true">
                                    {formatCount(rarityGroup.ownedTotal, rarityGroup.operators.length, language)}
                                  </span>
                                </button>
                              </h4>
                            </div>
                            {!rarityCollapsed ? (
                              <div className="operator-grid">
                                {rarityGroup.operators.map((operator) => (
                                  <OperatorCard
                                    key={operator.id}
                                    operator={operator}
                                    entry={state.roster[operator.id]}
                                    language={language}
                                    onUpdateRoster={updateRoster}
                                  />
                                ))}
                              </div>
                            ) : null}
                          </section>
                        );
                      })
                    : null}
                </section>
              );
            })}
          </div>
        </section>
      ) : null}

      {activeTab === "plan" ? (
        <section className="panel" aria-labelledby="plan-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{text.plan.eyebrow}</p>
              <h2 id="plan-title">{text.plan.title}</h2>
            </div>
            <p className="timestamp">
              {text.plan.generated}: {new Date(plan.generatedAt).toLocaleString(dateLocale(language))}
            </p>
          </div>

          <div className="plan-metrics" aria-label={`${text.stats.dailyValue} / ${text.stats.totalScore}`}>
            <Stat icon={SlidersHorizontal} label={text.stats.dailyValue} value={plan.dailyValue.toFixed(1)} />
            <Stat icon={Archive} label={text.stats.totalScore} value={plan.totalScore.toFixed(1)} />
          </div>

          <div className="recommendation-controls" aria-label={text.plan.conditions}>
            <div className="preference-section">
              <div className="preference-heading">
                <h3>{text.plan.productionPriority}</h3>
                <p>{text.plan.productionPriorityNote}</p>
              </div>
              <div className="preference-grid" role="radiogroup" aria-label={text.plan.productionPriority}>
                {preferencePresets.map((preset) => (
                  <label
                    key={preset.id}
                    className={
                      selectedPreferencePreset(state.preference) === preset.id ? "preference-option active" : "preference-option"
                    }
                  >
                    <input
                      type="radio"
                      name="production-priority"
                      value={preset.id}
                      checked={selectedPreferencePreset(state.preference) === preset.id}
                      onChange={() => updatePreferencePreset(preset.id)}
                    />
                    <span>
                      {preferenceLabels[language][preset.id]}
                    </span>
                  </label>
                ))}
              </div>
            </div>

          </div>

          {plan.warnings.map((warning) => (
            <p key={warning} className="warning">
              {localizeWarning(warning, language)}
            </p>
          ))}

          <div className="rotation-sections" aria-label={text.plan.rotationSuggestions}>
            {plan.rotation.map((window, rotationIndex) => (
              <section key={window.label} className="rotation-section" aria-labelledby={`rotation-${rotationIndex + 1}`}>
                <div className="rotation-section-heading">
                  <h3 id={`rotation-${rotationIndex + 1}`}>{text.plan.rotationLabel(rotationIndex, state.rotationCount)}</h3>
                  <span>{window.hours}h</span>
                </div>
                <div className="plan-grid">
                  {plan.facilityPlans.map((facilityPlan) => (
                    <FacilityPlanCard
                      key={`${window.label}-${facilityPlan.facility.id}`}
                      facilityPlan={facilityPlan}
                      assignments={rotationAssignmentsForFacility(facilityPlan, rotationIndex)}
                      language={language}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}

function Stat({ icon: Icon, label, value }: { icon: typeof Users; label: string; value: string }) {
  return (
    <div className="stat">
      <Icon size={20} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function OperatorCard({
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
            <span>{operator.name}</span>
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
      <ul className="base-skill-list" aria-label={text.roster.skillListLabel(operator.name)}>
        {operator.skills.map((skill) => {
          const unlocked = skill.unlockPhase <= entry.elite;
          return (
            <li key={skill.id} className={unlocked ? "base-skill unlocked" : "base-skill locked"}>
              <div className="base-skill-heading">
                <strong>{skill.name}</strong>
                <span>{unlocked ? text.roster.unlocked : text.roster.unlockAtElite(skill.unlockPhase)}</span>
              </div>
              {skill.effects.map((effect, index) => (
                <p key={`${skill.id}-${index}`}>
                  {facilityLabels[language][effect.facility]}
                  {effect.product ? ` / ${productLabels[language][effect.product]}` : ""}: {effect.description}
                </p>
              ))}
            </li>
          );
        })}
      </ul>
    </article>
  );
}

function groupOperatorsByProfessionAndRarity(operatorList: Operator[], roster: Record<string, RosterEntry>) {
  const professions = Array.from(new Set(operatorList.map((operator) => operator.profession))).sort(
    (a, b) => professionSortIndex(a) - professionSortIndex(b)
  );

  return professions.map((profession) => {
    const professionOperators = operatorList.filter((operator) => operator.profession === profession);
    const rarities = Array.from(new Set(professionOperators.map((operator) => operator.rarity))).sort((a, b) => b - a);
    const ownedTotal = countOwnedOperators(professionOperators, roster);

    return {
      profession,
      total: professionOperators.length,
      ownedTotal,
      rarityGroups: rarities.map((rarity) => {
        const rarityOperators = professionOperators
          .filter((operator) => operator.rarity === rarity)
          .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));

        return {
          rarity,
          ownedTotal: countOwnedOperators(rarityOperators, roster),
          operators: rarityOperators
        };
      })
    };
  });
}

function countOwnedOperators(operatorList: Operator[], roster: Record<string, RosterEntry>) {
  return operatorList.filter((operator) => roster[operator.id]?.owned).length;
}

function formatCount(owned: number, total: number, language: LanguageCode) {
  const suffix = uiText[language].roster.countSuffix;
  return `${owned} / ${total}${suffix}`;
}

function formatFacilityName(facility: FacilitySlot, language: LanguageCode) {
  const baseName = facilityLabels[language][facility.type];

  if (facility.type === "factory" || facility.type === "trading" || facility.type === "power") {
    const roomNumber = Number(facility.id.split("-").at(-1));
    const suffix = Number.isFinite(roomNumber) ? String.fromCharCode(64 + roomNumber) : "";
    return suffix ? `${baseName} ${suffix}` : baseName;
  }

  return baseName;
}

function localizeWarning(warning: string, language: LanguageCode) {
  return warning ? uiText[language].warnings.candidateShortage : warning;
}

function dateLocale(language: LanguageCode) {
  if (language === "zh") {
    return "zh-CN";
  }
  if (language === "en") {
    return "en-US";
  }
  return "ja-JP";
}

function toggleSetValue(current: Set<string>, value: string) {
  const next = new Set(current);

  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }

  return next;
}

function rarityGroupKey(profession: string, rarity: number) {
  return `${profession}-${rarity}`;
}

function isInteractiveCardTarget(target: EventTarget) {
  return target instanceof Element && Boolean(target.closest("button, input, label, select, textarea, a"));
}

function professionSortIndex(profession: OperatorProfession) {
  const index = professionOrder.indexOf(profession);
  return index === -1 ? professionOrder.length : index;
}

function operatorName(operatorId: string): string {
  return operators.find((operator) => operator.id === operatorId)?.name ?? operatorId;
}

function selectedPreferencePreset(preference: { gold: number; battleRecord: number; lmd: number }): PreferencePresetId {
  if (preference.gold > preference.battleRecord && preference.gold > preference.lmd) {
    return "gold";
  }
  if (preference.battleRecord > preference.gold && preference.battleRecord > preference.lmd) {
    return "battleRecord";
  }
  if (preference.lmd > preference.gold && preference.lmd > preference.battleRecord) {
    return "lmd";
  }
  return "balanced";
}

function rotationAssignmentsForFacility(facilityPlan: FacilityPlan, rotationIndex: number): Assignment[] {
  if (rotationIndex === 0) {
    return facilityPlan.assignments;
  }

  return facilityPlan.alternatives.slice(0, facilityPlan.facility.slotCount);
}

function FacilityPlanCard({
  facilityPlan,
  assignments,
  language
}: {
  facilityPlan: FacilityPlan;
  assignments: Assignment[];
  language: LanguageCode;
}) {
  const expectedEfficiency = assignments.reduce((sum, assignment) => sum + assignment.efficiency, 0);
  const text = uiText[language];

  return (
    <article className={`plan-card plan-card-${facilityPlan.facility.type}`}>
      <div className="plan-card-heading">
        <div>
          <h4>{formatFacilityName(facilityPlan.facility, language)}</h4>
        </div>
        <strong>+{Math.round(expectedEfficiency * 100)}%</strong>
      </div>
      {assignments.length ? (
        <ul className="assignment-list">
          {assignments.map((assignment) => (
            <li key={`${assignment.facilityId}-${assignment.operatorId}`}>
              <Check size={16} />
              <span>
                {operatorName(assignment.operatorId)}
                <small>{assignment.reason}</small>
              </span>
              <b>{assignment.score.toFixed(1)}</b>
            </li>
          ))}
        </ul>
      ) : (
        <p className="alternatives">{text.plan.noCandidates}</p>
      )}
    </article>
  );
}
