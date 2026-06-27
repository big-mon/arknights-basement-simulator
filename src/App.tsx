import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Factory,
  Home,
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
import { generateAssignmentPlan } from "./lib/optimizer";
import { exportState, importState, loadState, saveState } from "./lib/storage";
import type {
  AppState,
  BaseLayout,
  FacilityType,
  FacilityPlan,
  Assignment,
  Operator,
  OperatorProfession,
  ProductType,
  RosterEntry,
  RotationCount
} from "./types";

type TabId = "roster" | "plan";

const facilityLabels: Record<FacilityType, string> = {
  factory: "製造所",
  trading: "貿易所",
  power: "発電所",
  control: "制御中枢",
  dormitory: "宿舎"
};

const productLabels: Record<ProductType, string> = {
  gold: "純金",
  battleRecord: "作戦記録",
  lmd: "龍門幣",
  power: "ドローン",
  morale: "体力回復"
};

const tabs: Array<{ id: TabId; label: string; icon: typeof Users }> = [
  { id: "roster", label: "所有", icon: Users },
  { id: "plan", label: "提案", icon: Activity }
];

const professionOrder: OperatorProfession[] = ["先鋒", "前衛", "重装", "狙撃", "術師", "医療", "補助", "特殊", "その他"];

const preferencePresets = [
  {
    id: "balanced",
    label: "バランス",
    description: "純金・作戦記録・龍門幣を近い重みで評価",
    preference: { gold: 0.35, battleRecord: 0.35, lmd: 0.3 }
  },
  {
    id: "gold",
    label: "純金優先",
    description: "純金向けの製造所スキルを高く評価",
    preference: { gold: 0.7, battleRecord: 0.15, lmd: 0.15 }
  },
  {
    id: "battleRecord",
    label: "作戦記録優先",
    description: "作戦記録向けの製造所スキルを高く評価",
    preference: { gold: 0.15, battleRecord: 0.7, lmd: 0.15 }
  },
  {
    id: "lmd",
    label: "龍門幣優先",
    description: "貿易所の龍門幣効率を高く評価",
    preference: { gold: 0.15, battleRecord: 0.15, lmd: 0.7 }
  }
] as const;

type PreferencePresetId = (typeof preferencePresets)[number]["id"];

export function App() {
  const [state, setState] = useState<AppState>(() => loadState());
  const [activeTab, setActiveTab] = useState<TabId>("roster");
  const [query, setQuery] = useState("");
  const [professionFilter, setProfessionFilter] = useState("all");
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
  const professions = Array.from(new Set(operators.map((operator) => operator.profession))).sort();

  const filteredOperators = operators.filter((operator) => {
    const matchesQuery = `${operator.name} ${operator.id}`.toLowerCase().includes(query.toLowerCase());
    const matchesProfession = professionFilter === "all" || operator.profession === professionFilter;
    return matchesQuery && matchesProfession;
  });
  const groupedOperators = groupOperatorsByProfessionAndRarity(filteredOperators);

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
    setNotice("所有情報と基地設定をJSONに書き出しました。");
  }

  async function importJson(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      setState(importState(await file.text()));
      setNotice("JSONから設定を読み込みました。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "JSONを読み込めませんでした。");
    } finally {
      event.target.value = "";
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">ARKNIGHTS BASEMENT</p>
          <h1>基地ローテーションシミュレーター</h1>
        </div>
        <div className="toolbar" aria-label="保存データ操作">
          <button type="button" className="icon-button" onClick={downloadJson} title="JSONを書き出す">
            <Download size={18} />
          </button>
          <button type="button" className="icon-button" onClick={() => fileInputRef.current?.click()} title="JSONを読み込む">
            <Upload size={18} />
          </button>
          <button type="button" className="icon-button" onClick={() => setState(createDefaultState())} title="初期状態に戻す">
            <RotateCcw size={18} />
          </button>
          <input ref={fileInputRef} className="sr-only" type="file" accept="application/json" onChange={importJson} />
        </div>
      </header>

      <section className="summary-strip" aria-label="現在の概要">
        <Stat icon={Users} label="所有" value={`${ownedCount}/${operators.length}`} />
        <Stat icon={Factory} label="構成" value={`${selectedLayout}型`} />
        <Stat icon={SlidersHorizontal} label="日次価値" value={plan.dailyValue.toFixed(1)} />
        <Stat icon={Archive} label="総合スコア" value={plan.totalScore.toFixed(1)} />
      </section>

      {notice ? <p className="notice">{notice}</p> : null}

      <nav className="tabs" aria-label="主要画面">
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
              {tab.label}
            </button>
          );
        })}
      </nav>

      {activeTab === "roster" ? (
        <section className="panel" aria-labelledby="roster-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Roster</p>
              <h2 id="roster-title">所有オペレーター管理</h2>
            </div>
            <div className="filters">
              <label className="search-box">
                <Search size={17} />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名前で検索" />
              </label>
              <select value={professionFilter} onChange={(event) => setProfessionFilter(event.target.value)}>
                <option value="all">全職業</option>
                {professions.map((profession) => (
                  <option key={profession} value={profession}>
                    {profession}
                  </option>
                ))}
              </select>
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
                        <span>{professionGroup.profession}</span>
                        <span className="collapse-count" aria-hidden="true">
                          {professionGroup.total}名
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
                                    {rarityGroup.operators.length}名
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
              <p className="eyebrow">Recommendation</p>
              <h2 id="plan-title">推奨配置とローテーション</h2>
            </div>
            <p className="timestamp">生成: {new Date(plan.generatedAt).toLocaleString("ja-JP")}</p>
          </div>

          <div className="recommendation-controls" aria-label="提案条件">
            <div className="layout-selector" aria-label="基地構成">
              {(Object.keys(layoutPresets) as BaseLayout[]).map((layout) => (
                <button
                  key={layout}
                  type="button"
                  aria-pressed={selectedLayout === layout}
                  className={selectedLayout === layout ? "layout-option active" : "layout-option"}
                  onClick={() => updateLayout(layout)}
                >
                  <Home size={18} />
                  <span>
                    {layoutPresets[layout].label}
                    <small>{layoutPresets[layout].description}</small>
                  </span>
                </button>
              ))}
            </div>

            <div className="rotation-selector" aria-label="ローテーション回数">
              <button
                type="button"
                className={selectedRotationCount === 2 ? "rotation-option active" : "rotation-option"}
                aria-pressed={selectedRotationCount === 2}
                onClick={() => updateRotationCount(2)}
              >
                <Check size={16} />
                <span>2回</span>
                <small>選択中</small>
              </button>
              <button
                type="button"
                className={state.rotationCount === 3 ? "rotation-option active" : "rotation-option"}
                aria-pressed={state.rotationCount === 3}
                disabled
                title="今後対応予定"
              >
                3回
                <small>準備中</small>
              </button>
            </div>

            <div className="preference-section">
              <div className="preference-heading">
                <h3>生産物の優先度</h3>
                <p>選んだ方針に合わせて、対応する基地スキルと施設配置を強く評価します。</p>
              </div>
              <div className="preference-grid" role="radiogroup" aria-label="生産物の優先度">
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
                      {preset.label}
                      <small>{preset.description}</small>
                    </span>
                  </label>
                ))}
              </div>
            </div>

          </div>

          {plan.warnings.map((warning) => (
            <p key={warning} className="warning">
              {warning}
            </p>
          ))}

          <div className="rotation-sections" aria-label="ローテーション別提案">
            {plan.rotation.map((window, rotationIndex) => (
              <section key={window.label} className="rotation-section" aria-labelledby={`rotation-${rotationIndex + 1}`}>
                <div className="rotation-section-heading">
                  <h3 id={`rotation-${rotationIndex + 1}`}>{window.label}</h3>
                  <span>{window.hours}h</span>
                </div>
                <div className="plan-grid">
                  {plan.facilityPlans.map((facilityPlan) => (
                    <FacilityPlanCard
                      key={`${window.label}-${facilityPlan.facility.id}`}
                      facilityPlan={facilityPlan}
                      assignments={rotationAssignmentsForFacility(facilityPlan, rotationIndex)}
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
  onUpdateRoster
}: {
  operator: Operator;
  entry: RosterEntry;
  onUpdateRoster: (operatorId: string, patch: Partial<RosterEntry>) => void;
}) {
  const unlockedSkills = operator.skills.filter((skill) => skill.unlockPhase <= entry.elite).length;

  return (
    <article className={entry.owned ? "operator-card owned" : "operator-card"}>
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
            ★{operator.rarity} / {operator.profession} / 基地スキル {unlockedSkills}/{operator.skills.length}
          </p>
        </div>
        <div className="operator-controls">
          <label>
            昇進
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
      <ul className="base-skill-list" aria-label={`${operator.name}の基地スキル`}>
        {operator.skills.map((skill) => {
          const unlocked = skill.unlockPhase <= entry.elite;
          return (
            <li key={skill.id} className={unlocked ? "base-skill unlocked" : "base-skill locked"}>
              <div className="base-skill-heading">
                <strong>{skill.name}</strong>
                <span>{unlocked ? "解放済み" : `昇進${skill.unlockPhase}で解放`}</span>
              </div>
              {skill.effects.map((effect, index) => (
                <p key={`${skill.id}-${index}`}>
                  {facilityLabels[effect.facility]}
                  {effect.product ? ` / ${productLabels[effect.product]}` : ""}: {effect.description}
                </p>
              ))}
            </li>
          );
        })}
      </ul>
    </article>
  );
}

function groupOperatorsByProfessionAndRarity(operatorList: Operator[]) {
  const professions = Array.from(new Set(operatorList.map((operator) => operator.profession))).sort(
    (a, b) => professionSortIndex(a) - professionSortIndex(b)
  );

  return professions.map((profession) => {
    const professionOperators = operatorList.filter((operator) => operator.profession === profession);
    const rarities = Array.from(new Set(professionOperators.map((operator) => operator.rarity))).sort((a, b) => b - a);

    return {
      profession,
      total: professionOperators.length,
      rarityGroups: rarities.map((rarity) => ({
        rarity,
        operators: professionOperators
          .filter((operator) => operator.rarity === rarity)
          .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))
      }))
    };
  });
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

function FacilityPlanCard({ facilityPlan, assignments }: { facilityPlan: FacilityPlan; assignments: Assignment[] }) {
  const expectedEfficiency = assignments.reduce((sum, assignment) => sum + assignment.efficiency, 0);

  return (
    <article className={`plan-card plan-card-${facilityPlan.facility.type}`}>
      <div className="plan-card-heading">
        <div>
          <h4>{facilityPlan.facility.name}</h4>
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
        <p className="alternatives">候補なし</p>
      )}
    </article>
  );
}
