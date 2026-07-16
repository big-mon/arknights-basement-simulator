import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Archive,
  AtSign,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Github,
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
  createDefaultRosterEntry,
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
import { exportState, importState, loadState, maxImportJsonBytes, saveState } from "./lib/storage";
import type {
  AppState,
  AssignmentPlan,
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

const calculationStatus: Record<LanguageCode, { title: string; description: string; elapsed: (seconds: number) => string }> = {
  ja: {
    title: "配置を計算しています",
    description: "最適な組み合わせを探索しています。しばらくお待ちください。",
    elapsed: (seconds) => `${seconds}秒経過`
  },
  zh: {
    title: "正在计算设施配置",
    description: "正在搜索最佳组合，请稍候。",
    elapsed: (seconds) => `已计算 ${seconds} 秒`
  },
  en: {
    title: "Calculating assignments",
    description: "Searching for the best combinations. Please wait.",
    elapsed: (seconds) => `${seconds} second${seconds === 1 ? "" : "s"} elapsed`
  }
};

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

const calculationNotes: Record<LanguageCode, { title: string; items: string[] }> = {
  ja: {
    title: "計算前提と未換算効果",
    items: [
      "施設レベルは上限として扱います。貿易所・製造所・発電所・応接室・訓練室はLv3、制御中枢と宿舎はLv5、宿舎合計レベルは20です。",
      "時間経過・体力消費で変動する基地スキルは、現在の12時間ローテーション内の平均効率として計算します。",
      "ドローン上限、建設ロボット、注文上限、保管上限などの基地状態由来の値は、現行モデルで扱える上限相当の値に固定しています。",
      "勤務時間で変動する高価値オーダー確率、事務連絡、訓練室効果、手がかり傾向など期待値換算していない効果は、最適化計算対象外として表示します。",
      "グレイディーアなどの特殊加算制限や体力状態による分岐は、基本効果と明示できる資源効果のみを扱い、専用比較ルールが必要な部分は完全再現していません。"
    ]
  },
  zh: {
    title: "计算前提与未换算效果",
    items: [
      "设施等级按上限处理：贸易站、制造站、发电站、会客室、训练室为3级，控制中枢和宿舍为5级，宿舍总等级为20。",
      "随工作时间或心情消耗变化的基建技能，按当前12小时轮班内的平均效率计算。",
      "无人机上限、建造机器人、订单上限、仓库上限等基地状态值固定为当前模型可处理的上限值。",
      "随工作时间变化的高价值订单概率、办公室联络、训练室效果、线索倾向等尚未换算为期望收益的效果，会显示为不参与优化计算。",
      "歌蕾蒂娅等特殊加成限制和心情状态分支，只处理基础效果与可明确建模的资源效果；需要专用比较规则的部分尚未完全复现。"
    ]
  },
  en: {
    title: "Calculation Assumptions",
    items: [
      "Facility levels are treated as capped: Trading Posts, Factories, Power Plants, Reception Room, and Training Room are level 3; Control Center and Dormitories are level 5; total Dormitory level is 20.",
      "Base skills that vary with elapsed time or Morale spent are averaged across the current 12-hour rotation window.",
      "Base-state values such as drone cap, construction robots, order limit, and storage limit use the capped values currently supported by the model.",
      "Effects not converted to expected value, such as time-varying high-value order chance, HR office contact speed, training effects, and clue bias, are shown as excluded from optimization.",
      "Special stacking limits and morale-state branches, such as Gladiia's Abyssal Hunter interactions, only apply their base effects and explicitly modeled resource effects for now."
    ]
  }
};

export function App() {
  const [state, setState] = useState<AppState>(() => loadState());
  const [activeTab, setActiveTab] = useState<TabId>("roster");
  const [query, setQuery] = useState("");
  const [professionFilter, setProfessionFilter] = useState("all");
  const [rarityFilter, setRarityFilter] = useState<RarityFilter>("all");
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [collapsedProfessions, setCollapsedProfessions] = useState<Set<string>>(() => new Set());
  const [collapsedRarityGroups, setCollapsedRarityGroups] = useState<Set<string>>(() => new Set());
  const [notice, setNotice] = useState("");
  const [plan, setPlan] = useState<AssignmentPlan>();
  const [isCalculatingPlan, setIsCalculatingPlan] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const calculatedPlanInputKeyRef = useRef<string | undefined>(undefined);
  const planInputKey = useMemo(() => optimizationInputKey(state), [state]);

  useEffect(() => {
    saveState(state);
  }, [state]);

  useEffect(() => {
    if (activeTab !== "plan") return;
    if (plan && calculatedPlanInputKeyRef.current === planInputKey) return;

    setPlan(undefined);
    setIsCalculatingPlan(true);

    if (typeof Worker === "undefined") {
      const nextPlan = generateAssignmentPlan(state);
      calculatedPlanInputKeyRef.current = planInputKey;
      setPlan(nextPlan);
      setIsCalculatingPlan(false);
      return;
    }

    const worker = new Worker(new URL("./workers/optimizer.worker.ts", import.meta.url), { type: "module" });
    let cancelled = false;
    worker.onmessage = (event: MessageEvent<AssignmentPlan>) => {
      if (cancelled) return;

      calculatedPlanInputKeyRef.current = planInputKey;
      setPlan(event.data);
      setIsCalculatingPlan(false);
      worker.terminate();
    };
    worker.postMessage(state);

    return () => {
      cancelled = true;
      worker.terminate();
    };
  }, [activeTab, planInputKey]);
  const selectedLayout = isBaseLayout(state.layout) ? state.layout : defaultLayout;
  const ownedCount = Object.values(state.roster).filter((entry) => entry.owned).length;
  const language = state.language;
  const text = uiText[language];
  const notes = calculationNotes[language];
  const professions = getProfessions(operators);
  const rarities = getRarities(operators);
  const matchingOperators = filterOperators(operators, query, professionFilter, rarityFilter);
  const filteredOperators = ownedOnly
    ? matchingOperators.filter((operator) => state.roster[operator.id]?.owned)
    : matchingOperators;
  const groupedOperators = groupOperatorsByProfessionAndRarity(filteredOperators, state.roster, language);

  const updateRoster = useCallback((operatorId: string, patch: Partial<RosterEntry>) => {
    const operator = operators.find((candidate) => candidate.id === operatorId);
    const normalizedPatch =
      operator && "elite" in patch ? { ...patch, elite: clampEliteForOperator(operator, patch.elite) } : patch;

    setState((current) => ({
      ...current,
      roster: {
        ...current.roster,
        [operatorId]: {
          ...(operator ? createDefaultRosterEntry(operator) : defaultRosterEntry()),
          ...current.roster[operatorId],
          ...normalizedPatch
        }
      }
    }));
  }, []);

  function updateVisibleOwnership(owned: boolean) {
    setState((current) => {
      const roster = { ...current.roster };
      for (const operator of filteredOperators) {
        roster[operator.id] = {
          ...createDefaultRosterEntry(operator),
          ...roster[operator.id],
          owned
        };
      }
      return { ...current, roster };
    });
  }

  function showPlan() {
    setActiveTab("plan");
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
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

    if (file.size > maxImportJsonBytes) {
      setNotice(`JSONファイルは${maxImportJsonBytes / 1024}KiB以下にしてください。`);
      event.target.value = "";
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
    <>
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
              className="rotation-option active"
              aria-pressed={true}
              onClick={() => updateRotationCount(2)}
            >
              <Check size={16} />
              <span>{text.plan.rotationOption(2)}</span>
              <small>{text.plan.selected}</small>
            </button>
            <button
              type="button"
              className="rotation-option"
              aria-pressed={false}
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
              <p className="scope-note">{text.roster.scopeNote}</p>
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

            <div className="roster-filter-actions">
              <label className={ownedOnly ? "filter-chip active" : "filter-chip"}>
                <input type="checkbox" checked={ownedOnly} onChange={(event) => setOwnedOnly(event.target.checked)} />
                <span>{rosterActionLabels[language].ownedOnly}</span>
              </label>
              <span className="filter-result-count">{rosterActionLabels[language].visibleCount(filteredOperators.length)}</span>
              <button type="button" className="secondary-button" onClick={() => updateVisibleOwnership(true)}>
                {rosterActionLabels[language].selectVisible}
              </button>
              <button type="button" className="secondary-button" onClick={() => updateVisibleOwnership(false)}>
                {rosterActionLabels[language].clearVisible}
              </button>
              <button type="button" className="plan-cta" disabled={ownedCount === 0} onClick={showPlan}>
                <Activity size={18} />
                <span>{rosterActionLabels[language].showPlan(ownedCount)}</span>
              </button>
            </div>
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
                                    entry={state.roster[operator.id] ?? createDefaultRosterEntry(operator)}
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

      {activeTab === "plan" && isCalculatingPlan ? <PlanCalculationStatus language={language} /> : null}

      {activeTab === "plan" && plan && !isCalculatingPlan ? (
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
              <details key={window.label} className="rotation-section" open={rotationIndex === 0}>
                <summary className="rotation-section-heading">
                  <h3 id={`rotation-${rotationIndex + 1}`}>{text.plan.rotationLabel(rotationIndex, state.rotationCount)}</h3>
                  <span>{window.hours}h · {rotationIndex === 0 ? planResultLabels[language].primary : planResultLabels[language].secondary}</span>
                </summary>
                <div className="plan-grid">
                  {plan.facilityPlans.map((facilityPlan) => (
                    <FacilityPlanCard
                      key={`${window.label}-${facilityPlan.facility.id}`}
                      facilityPlan={facilityPlan}
                      assignments={rotationAssignmentsForFacility(facilityPlan, rotationIndex)}
                      expectedEfficiency={rotationExpectedEfficiencyForFacility(facilityPlan, rotationIndex)}
                      language={language}
                      operatorNameById={(operatorId) => operatorNameById(operators, operatorId, language)}
                    />
                  ))}
                </div>
              </details>
            ))}
          </div>
        </section>
      ) : null}

      <section className="calculation-notes" aria-labelledby="calculation-notes-title">
        <h2 id="calculation-notes-title">{notes.title}</h2>
        <ul>
          {notes.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      </main>
      <footer className="app-footer">
        <div className="app-footer-content">
          <p className="app-footer-notice">{fanMadeNotices[language]}</p>
          <a href="https://github.com/big-mon/arknights-basement-simulator" target="_blank" rel="noreferrer">
            <Github size={16} />
            <span>big-mon/arknights-basement-simulator</span>
          </a>
          <a href="https://x.com/BIG_MON" target="_blank" rel="noreferrer">
            <AtSign size={16} />
            <span>@BIG_MON</span>
          </a>
        </div>
      </footer>
    </>
  );
}

function PlanCalculationStatus({ language }: { language: LanguageCode }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setElapsedSeconds((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const status = calculationStatus[language];

  return (
    <section className="panel calculation-panel" role="status" aria-busy="true">
      <span className="calculation-spinner" aria-hidden="true" />
      <div>
        <h2>{status.title}</h2>
        <p>{status.description}</p>
        <p className="calculation-elapsed" aria-hidden="true">
          {status.elapsed(elapsedSeconds)}
        </p>
      </div>
    </section>
  );
}

const rosterActionLabels: Record<
  LanguageCode,
  {
    ownedOnly: string;
    selectVisible: string;
    clearVisible: string;
    visibleCount: (count: number) => string;
    showPlan: (count: number) => string;
  }
> = {
  ja: {
    ownedOnly: "選択済みのみ",
    selectVisible: "表示中をすべて選択",
    clearVisible: "表示中をすべて解除",
    visibleCount: (count) => `${count}人表示`,
    showPlan: (count) => `選択した${count}人で配置を計算`
  },
  zh: {
    ownedOnly: "仅显示已选择",
    selectVisible: "全选当前显示",
    clearVisible: "取消当前显示",
    visibleCount: (count) => `显示 ${count} 人`,
    showPlan: (count) => `使用已选择的 ${count} 人计算配置`
  },
  en: {
    ownedOnly: "Selected only",
    selectVisible: "Select all shown",
    clearVisible: "Clear all shown",
    visibleCount: (count) => `${count} shown`,
    showPlan: (count) => `Calculate with ${count} selected`
  }
};

const planResultLabels: Record<LanguageCode, { primary: string; secondary: string }> = {
  ja: { primary: "最初に確認", secondary: "クリックして展開" },
  zh: { primary: "优先查看", secondary: "点击展开" },
  en: { primary: "Primary", secondary: "Click to expand" }
};

const fanMadeNotices: Record<LanguageCode, string> = {
  ja: "本サイトは非公式のファンメイドツールです。掲載画像等の権利は各権利者に帰属し、公式から削除要請をいただいた場合は速やかに対応します。ご連絡は下記のXアカウントへお願いいたします。",
  zh: "本网站是非官方粉丝制作工具。所用图片等内容的权利归各权利人所有；如收到官方删除要求，我们将及时处理。请通过下方的 X 账号联系我们。",
  en: "This is an unofficial fan-made tool. Rights to the images and other game content belong to their respective owners, and we will promptly comply with official removal requests. Please contact us through the X account below."
};

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

function optimizationInputKey(state: AppState) {
  return JSON.stringify({
    language: state.language,
    layout: state.layout,
    rotationCount: state.rotationCount,
    roster: state.roster,
    facilities: state.facilities,
    preference: state.preference
  });
}

export function rotationAssignmentsForFacility(facilityPlan: FacilityPlan, rotationIndex: number): Assignment[] {
  const assignments =
    rotationIndex === 0
      ? facilityPlan.assignments
      : assignmentsForFacilitySlots(facilityPlan.alternatives, facilityPlan.facility.slotCount);
  return assignments.filter((assignment) => !assignment.doesNotConsumeFacilitySlot);
}

function rotationExpectedEfficiencyForFacility(facilityPlan: FacilityPlan, rotationIndex: number) {
  if (rotationIndex === 0) {
    return facilityPlan.expectedEfficiency;
  }

  return (
    facilityPlan.alternativeExpectedEfficiency ??
    assignmentsForFacilitySlots(facilityPlan.alternatives, facilityPlan.facility.slotCount).reduce((sum, assignment) => sum + assignment.efficiency, 0)
  );
}

export function assignmentsForFacilitySlots(assignments: Assignment[], slotCount: number): Assignment[] {
  const selected: Assignment[] = [];
  let occupiedSlots = 0;

  for (const assignment of assignments) {
    if (assignment.doesNotConsumeFacilitySlot) {
      selected.push(assignment);
      continue;
    }
    if (occupiedSlots < slotCount) {
      selected.push(assignment);
      occupiedSlots += 1;
    }
  }

  return selected;
}
