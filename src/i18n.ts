import type { BaseLayout, FacilityType, LanguageCode, OperatorProfession, ProductType } from "./types";

export const languageOptions: Array<{ code: LanguageCode; label: string }> = [
  { code: "ja", label: "日本語" },
  { code: "zh", label: "中文" },
  { code: "en", label: "English" }
];

export const defaultLanguage: LanguageCode = "ja";

export function isLanguageCode(value: unknown): value is LanguageCode {
  return value === "ja" || value === "zh" || value === "en";
}

export const uiText = {
  ja: {
    appTitle: "基地ローテーションシミュレーター",
    language: "言語",
    toolbarLabel: "保存データ操作",
    exportJson: "JSONを書き出す",
    importJson: "JSONを読み込む",
    reset: "初期状態に戻す",
    summaryLabel: "現在の概要",
    tabsLabel: "主要画面",
    tabs: {
      roster: "所有",
      plan: "提案"
    },
    stats: {
      owned: "所有",
      layout: "構成",
      dailyValue: "日次価値",
      totalScore: "総合スコア"
    },
    roster: {
      eyebrow: "Roster",
      title: "所有オペレーター管理",
      searchPlaceholder: "名前で検索",
      professionFilter: "職業",
      rarityFilter: "☆数",
      allProfessions: "全職業",
      allRarities: "全☆",
      countSuffix: "名",
      baseSkill: "基地スキル",
      elite: "昇進",
      unlocked: "解放済み",
      unlockAtElite: (phase: number) => `昇進${phase}で解放`,
      missingLocalizedName: "選択中の言語名未収録",
      skillListLabel: (name: string) => `${name}の基地スキル`
    },
    plan: {
      eyebrow: "Recommendation",
      title: "推奨配置とローテーション",
      generated: "生成",
      conditions: "提案条件",
      baseLayout: "基地構成",
      rotationCount: "ローテーション回数",
      rotationOption: (count: number) => `${count}回`,
      selected: "選択中",
      planned: "準備中",
      futureSupport: "今後対応予定",
      productionPriority: "生産物の優先度",
      productionPriorityNote: "選んだ方針に合わせて、対応する基地スキルと施設配置を強く評価します。",
      rotationSuggestions: "ローテーション別提案",
      noCandidates: "候補なし",
      rotationLabel: (index: number, count: number) =>
        count === 3 ? `第${index + 1}ローテーション` : `${index + 1}回目ローテーション`
    },
    notices: {
      exported: "所有情報と基地設定をJSONに書き出しました。",
      imported: "JSONから設定を読み込みました。",
      importFailed: "JSONを読み込めませんでした。"
    },
    warnings: {
      candidateShortage: "一部施設でスロット数に対して候補オペレーターが不足しています。所有設定か昇進段階を見直してください。"
    },
    layoutSuffix: "型"
  },
  zh: {
    appTitle: "基建轮班模拟器",
    language: "语言",
    toolbarLabel: "保存数据操作",
    exportJson: "导出 JSON",
    importJson: "导入 JSON",
    reset: "恢复初始状态",
    summaryLabel: "当前概要",
    tabsLabel: "主要页面",
    tabs: {
      roster: "持有",
      plan: "推荐"
    },
    stats: {
      owned: "持有",
      layout: "布局",
      dailyValue: "日价值",
      totalScore: "总评分"
    },
    roster: {
      eyebrow: "Roster",
      title: "持有干员管理",
      searchPlaceholder: "按名称搜索",
      professionFilter: "职业",
      rarityFilter: "星级",
      allProfessions: "全部职业",
      allRarities: "全部星级",
      countSuffix: "人",
      baseSkill: "基建技能",
      elite: "精英化",
      unlocked: "已解锁",
      unlockAtElite: (phase: number) => `精英化${phase}解锁`,
      missingLocalizedName: "当前语言名称未收录",
      skillListLabel: (name: string) => `${name}的基建技能`
    },
    plan: {
      eyebrow: "Recommendation",
      title: "推荐配置与轮班",
      generated: "生成",
      conditions: "推荐条件",
      baseLayout: "基建布局",
      rotationCount: "轮班次数",
      rotationOption: (count: number) => `${count}次`,
      selected: "已选择",
      planned: "准备中",
      futureSupport: "后续支持",
      productionPriority: "产物优先级",
      productionPriorityNote: "根据所选方针，提高对应基建技能与设施配置的评分。",
      rotationSuggestions: "按轮班推荐",
      noCandidates: "无候选",
      rotationLabel: (index: number, count: number) => (count === 3 ? `第${index + 1}轮班` : `第${index + 1}次轮班`)
    },
    notices: {
      exported: "已将持有信息与基建设置导出为 JSON。",
      imported: "已从 JSON 读取设置。",
      importFailed: "无法读取 JSON。"
    },
    warnings: {
      candidateShortage: "部分设施的候选干员不足以填满栏位。请检查持有设置或精英化阶段。"
    },
    layoutSuffix: "型"
  },
  en: {
    appTitle: "Base Rotation Simulator",
    language: "Language",
    toolbarLabel: "Saved data actions",
    exportJson: "Export JSON",
    importJson: "Import JSON",
    reset: "Reset to defaults",
    summaryLabel: "Current summary",
    tabsLabel: "Main views",
    tabs: {
      roster: "Owned",
      plan: "Plan"
    },
    stats: {
      owned: "Owned",
      layout: "Layout",
      dailyValue: "Daily value",
      totalScore: "Total score"
    },
    roster: {
      eyebrow: "Roster",
      title: "Owned Operator Management",
      searchPlaceholder: "Search by name",
      professionFilter: "Class",
      rarityFilter: "Rarity",
      allProfessions: "All classes",
      allRarities: "All rarities",
      countSuffix: "",
      baseSkill: "Base skills",
      elite: "Elite",
      unlocked: "Unlocked",
      unlockAtElite: (phase: number) => `Unlocks at E${phase}`,
      missingLocalizedName: "Name missing for selected language",
      skillListLabel: (name: string) => `${name} base skills`
    },
    plan: {
      eyebrow: "Recommendation",
      title: "Recommended Assignments and Rotation",
      generated: "Generated",
      conditions: "Plan conditions",
      baseLayout: "Base layout",
      rotationCount: "Rotation count",
      rotationOption: (count: number) => `${count}`,
      selected: "Selected",
      planned: "Planned",
      futureSupport: "Coming later",
      productionPriority: "Production priority",
      productionPriorityNote: "The selected policy gives more weight to matching base skills and facility assignments.",
      rotationSuggestions: "Suggestions by rotation",
      noCandidates: "No candidates",
      rotationLabel: (index: number, count: number) => (count === 3 ? `Rotation ${index + 1}` : `Rotation ${index + 1}`)
    },
    notices: {
      exported: "Exported owned operators and base settings to JSON.",
      imported: "Loaded settings from JSON.",
      importFailed: "Could not read JSON."
    },
    warnings: {
      candidateShortage: "Some facilities do not have enough candidate operators for every slot. Check ownership or elite phases."
    },
    layoutSuffix: ""
  }
} as const;

export const facilityLabels: Record<LanguageCode, Record<FacilityType, string>> = {
  ja: {
    factory: "製造所",
    trading: "貿易所",
    power: "発電所",
    control: "制御中枢",
    dormitory: "宿舎",
    reception: "応接室"
  },
  zh: {
    factory: "制造站",
    trading: "贸易站",
    power: "发电站",
    control: "控制中枢",
    dormitory: "宿舍",
    reception: "会客室"
  },
  en: {
    factory: "Factory",
    trading: "Trading Post",
    power: "Power Plant",
    control: "Control Center",
    dormitory: "Dormitory",
    reception: "Reception Room"
  }
};

export const productLabels: Record<LanguageCode, Record<ProductType, string>> = {
  ja: {
    gold: "純金",
    battleRecord: "作戦記録",
    lmd: "龍門幣",
    power: "ドローン",
    morale: "体力回復",
    clue: "手がかり"
  },
  zh: {
    gold: "赤金",
    battleRecord: "作战记录",
    lmd: "龙门币",
    power: "无人机",
    morale: "心情恢复",
    clue: "线索"
  },
  en: {
    gold: "Gold",
    battleRecord: "Battle Records",
    lmd: "LMD",
    power: "Drones",
    morale: "Morale recovery",
    clue: "Clues"
  }
};

export const professionLabels: Record<LanguageCode, Record<OperatorProfession, string>> = {
  ja: {
    先鋒: "先鋒",
    前衛: "前衛",
    重装: "重装",
    狙撃: "狙撃",
    術師: "術師",
    医療: "医療",
    補助: "補助",
    特殊: "特殊",
    その他: "その他"
  },
  zh: {
    先鋒: "先锋",
    前衛: "近卫",
    重装: "重装",
    狙撃: "狙击",
    術師: "术师",
    医療: "医疗",
    補助: "辅助",
    特殊: "特种",
    その他: "其他"
  },
  en: {
    先鋒: "Vanguard",
    前衛: "Guard",
    重装: "Defender",
    狙撃: "Sniper",
    術師: "Caster",
    医療: "Medic",
    補助: "Supporter",
    特殊: "Specialist",
    その他: "Other"
  }
};

export const layoutLabels: Record<LanguageCode, Record<BaseLayout, { label: string; description: string }>> = {
  ja: {
    "243": { label: "243型", description: "貿易所2・製造所4・発電所3" },
    "153": { label: "153型", description: "貿易所1・製造所5・発電所3" }
  },
  zh: {
    "243": { label: "243型", description: "贸易站2・制造站4・发电站3" },
    "153": { label: "153型", description: "贸易站1・制造站5・发电站3" }
  },
  en: {
    "243": { label: "243", description: "2 Trading Posts, 4 Factories, 3 Power Plants" },
    "153": { label: "153", description: "1 Trading Post, 5 Factories, 3 Power Plants" }
  }
};

export const preferenceLabels: Record<LanguageCode, Record<"balanced" | "gold" | "battleRecord" | "lmd", string>> = {
  ja: {
    balanced: "バランス",
    gold: "純金優先",
    battleRecord: "作戦記録優先",
    lmd: "龍門幣優先"
  },
  zh: {
    balanced: "均衡",
    gold: "赤金优先",
    battleRecord: "作战记录优先",
    lmd: "龙门币优先"
  },
  en: {
    balanced: "Balanced",
    gold: "Gold",
    battleRecord: "Battle Records",
    lmd: "LMD"
  }
};
