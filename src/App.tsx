import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
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
import { FacilityPlanCard } from "./components/FacilityPlanCard";
import { OperatorCard } from "./components/OperatorCard";
import { Stat } from "./components/Stat";
import {
  createDefaultState,
  createFacilitiesForLayout,
  defaultLayout,
  isBaseLayout,
  layoutPresets,
  operators
} from "./data/defaults";
import {
  languageOptions,
  layoutLabels,
  preferenceLabels,
  professionLabels,
  uiText
} from "./i18n";
import { clampEliteForOperator } from "./lib/elite";
import { languageLocale } from "./lib/localization";
import { generateAssignmentPlan } from "./lib/optimizer";
import {
  filterOperators,
  getProfessions,
  getRarities,
  groupOperatorsByProfessionAndRarity,
  operatorNameById,
  rarityGroupKey
} from "./lib/operatorCatalog";
import { exportState, importState, loadState, saveState } from "./lib/storage";
import type {
  AppState,
  BaseLayout,
  FacilityPlan,
  Assignment,
  LanguageCode,
  Operator,
  RosterEntry,
  RotationCount
} from "./types";

type TabId = "roster" | "plan";
type RarityFilter = "all" | `${Operator["rarity"]}`;

const tabs: Array<{ id: TabId; icon: typeof Users }> = [
  { id: "roster", icon: Users },
  { id: "plan", icon: Activity }
];

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
  const professions = getProfessions(operators);
  const rarities = getRarities(operators);
  const filteredOperators = filterOperators(operators, query, professionFilter, rarityFilter);
  const groupedOperators = groupOperatorsByProfessionAndRarity(filteredOperators, state.roster, language);

  function updateRoster(operatorId: string, patch: Partial<RosterEntry>) {
    const operator = operators.find((candidate) => candidate.id === operatorId);
    const normalizedPatch =
      operator && "elite" in patch ? { ...patch, elite: clampEliteForOperator(operator, patch.elite) } : patch;

    setState((current) => ({
      ...current,
      roster: {
        ...current.roster,
        [operatorId]: {
          ...defaultRosterEntry(),
          ...current.roster[operatorId],
          ...normalizedPatch
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
                                    entry={state.roster[operator.id] ?? defaultRosterEntry()}
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
              {text.plan.generated}: {new Date(plan.generatedAt).toLocaleString(languageLocale(language))}
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
                      operatorNameById={(operatorId) => operatorNameById(operators, operatorId, language)}
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

function formatCount(owned: number, total: number, language: LanguageCode) {
  const suffix = uiText[language].roster.countSuffix;
  return `${owned} / ${total}${suffix}`;
}

function defaultRosterEntry(): RosterEntry {
  return {
    owned: false,
    elite: 0,
    level: 1,
    potential: 1,
    moduleEnabled: false
  };
}

function localizeWarning(warning: string, language: LanguageCode) {
  return warning ? uiText[language].warnings.candidateShortage : warning;
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
