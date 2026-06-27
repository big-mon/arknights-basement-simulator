import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Archive,
  Check,
  Download,
  Factory,
  Home,
  RotateCcw,
  Search,
  Settings2,
  SlidersHorizontal,
  Upload,
  Users
} from "lucide-react";
import { createDefaultState, createFacilitiesForLayout, layoutPresets, operators } from "./data/defaults";
import { generateAssignmentPlan } from "./lib/optimizer";
import { exportState, importState, loadState, saveState } from "./lib/storage";
import type { AppState, BaseLayout, FacilitySlot, FacilityType, OptimizationPreference, ProductType, RosterEntry } from "./types";

type TabId = "roster" | "base" | "plan";

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
  { id: "base", label: "基地", icon: Settings2 },
  { id: "plan", label: "提案", icon: Activity }
];

export function App() {
  const [state, setState] = useState<AppState>(() => loadState());
  const [activeTab, setActiveTab] = useState<TabId>("roster");
  const [query, setQuery] = useState("");
  const [professionFilter, setProfessionFilter] = useState("all");
  const [notice, setNotice] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    saveState(state);
  }, [state]);

  const plan = useMemo(() => generateAssignmentPlan(state), [state]);
  const ownedCount = Object.values(state.roster).filter((entry) => entry.owned).length;
  const professions = Array.from(new Set(operators.map((operator) => operator.profession))).sort();

  const filteredOperators = operators.filter((operator) => {
    const matchesQuery = `${operator.name} ${operator.id}`.toLowerCase().includes(query.toLowerCase());
    const matchesProfession = professionFilter === "all" || operator.profession === professionFilter;
    return matchesQuery && matchesProfession;
  });

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

  function updateFacility(facilityId: string, patch: Partial<FacilitySlot>) {
    setState((current) => ({
      ...current,
      facilities: current.facilities.map((facility) => (facility.id === facilityId ? { ...facility, ...patch } : facility))
    }));
  }

  function updateLayout(layout: BaseLayout) {
    setState((current) => ({
      ...current,
      layout,
      facilities: createFacilitiesForLayout(layout, current.facilities)
    }));
  }

  function updatePreference(key: keyof OptimizationPreference, value: number) {
    setState((current) => ({
      ...current,
      preference: {
        ...current.preference,
        [key]: value
      }
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
        <Stat icon={Factory} label="構成" value={`${state.layout}型`} />
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

          <div className="operator-grid">
            {filteredOperators.map((operator) => {
              const entry = state.roster[operator.id];
              const unlockedSkills = operator.skills.filter((skill) => skill.unlockPhase <= entry.elite).length;
              return (
                <article key={operator.id} className={entry.owned ? "operator-card owned" : "operator-card"}>
                  <div className="operator-card-main">
                    <label className="checkbox-line">
                      <input
                        type="checkbox"
                        checked={entry.owned}
                        onChange={(event) => updateRoster(operator.id, { owned: event.target.checked })}
                      />
                      <span>{operator.name}</span>
                    </label>
                    <p>
                      ★{operator.rarity} / {operator.profession} / 解放スキル {unlockedSkills}/{operator.skills.length}
                    </p>
                  </div>
                  <div className="operator-controls">
                    <label>
                      昇進
                      <select
                        value={entry.elite}
                        onChange={(event) => updateRoster(operator.id, { elite: Number(event.target.value) as 0 | 1 | 2 })}
                      >
                        <option value={0}>0</option>
                        <option value={1}>1</option>
                        <option value={2}>2</option>
                      </select>
                    </label>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {activeTab === "base" ? (
        <section className="panel" aria-labelledby="base-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Base</p>
              <h2 id="base-title">基地設定</h2>
            </div>
          </div>

          <div className="layout-selector" aria-label="基地構成">
            {(Object.keys(layoutPresets) as BaseLayout[]).map((layout) => (
              <button
                key={layout}
                type="button"
                className={state.layout === layout ? "layout-option active" : "layout-option"}
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

          <div className="preference-grid">
            <PreferenceSlider
              label="純金"
              value={state.preference.gold}
              onChange={(value) => updatePreference("gold", value)}
            />
            <PreferenceSlider
              label="作戦記録"
              value={state.preference.battleRecord}
              onChange={(value) => updatePreference("battleRecord", value)}
            />
            <PreferenceSlider
              label="龍門幣"
              value={state.preference.lmd}
              onChange={(value) => updatePreference("lmd", value)}
            />
          </div>

          <div className="facility-list">
            {state.facilities.map((facility) => (
              <article key={facility.id} className="facility-row">
                <strong>{facility.name}</strong>
                <span className="pill">{facilityLabels[facility.type]}</span>
                <span className="room-meta">{facility.slotCount}枠</span>
                <label>
                  生産
                  <select
                    value={facility.product}
                    disabled={facility.type !== "factory"}
                    onChange={(event) => updateFacility(facility.id, { product: event.target.value as ProductType })}
                  >
                    <option value="gold">純金</option>
                    <option value="battleRecord">作戦記録</option>
                    <option value="lmd">龍門幣</option>
                    <option value="power">ドローン</option>
                    <option value="morale">体力回復</option>
                  </select>
                </label>
              </article>
            ))}
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

          {plan.warnings.map((warning) => (
            <p key={warning} className="warning">
              {warning}
            </p>
          ))}

          <div className="plan-grid">
            {plan.facilityPlans.map((facilityPlan) => (
              <article key={facilityPlan.facility.id} className="plan-card">
                <div className="plan-card-heading">
                  <div>
                    <h3>{facilityPlan.facility.name}</h3>
                    <p>
                      {facilityLabels[facilityPlan.facility.type]} / {productLabels[facilityPlan.facility.product]}
                    </p>
                  </div>
                  <strong>+{Math.round(facilityPlan.expectedEfficiency * 100)}%</strong>
                </div>
                <ul className="assignment-list">
                  {facilityPlan.assignments.map((assignment) => (
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
                {facilityPlan.alternatives.length ? (
                  <p className="alternatives">
                    代替: {facilityPlan.alternatives.map((assignment) => operatorName(assignment.operatorId)).join(" / ")}
                  </p>
                ) : null}
              </article>
            ))}
          </div>

          <div className="rotation-table" role="table" aria-label="ローテーション">
            <div role="row" className="rotation-header">
              <span>時間帯</span>
              <span>稼働</span>
              <span>回復</span>
            </div>
            {plan.rotation.map((window) => (
              <div role="row" key={window.label} className="rotation-row">
                <span>
                  {window.label}
                  <small>{window.hours}h</small>
                </span>
                <span>{window.assignments.map((assignment) => operatorName(assignment.operatorId)).join(" / ") || "-"}</span>
                <span>{window.recovery.map((assignment) => operatorName(assignment.operatorId)).join(" / ") || "-"}</span>
              </div>
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

function PreferenceSlider({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="preference">
      <span>
        {label}
        <b>{Math.round(value * 100)}</b>
      </span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function operatorName(operatorId: string): string {
  return operators.find((operator) => operator.id === operatorId)?.name ?? operatorId;
}
