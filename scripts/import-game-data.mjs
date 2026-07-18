import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outputPath = path.join(root, "src", "data", "operators.json");
const nameOverridesPath = path.join(root, "src", "data", "operator-name-overrides.json");
const baseSkillOverridesPath = path.join(root, "src", "data", "base-skill-overrides.json");
const baseSkillLocalizationOverridesPath = path.join(root, "src", "data", "base-skill-localization-overrides.json");
const baseSkillLocalizationFallbacksPath = path.join(root, "src", "data", "base-skill-localization-fallbacks.json");
const sources = {
  zh: {
    characters:
      "https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/character_table.json",
    building:
      "https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/building_data.json"
  },
  ja: {
    characters:
      "https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData_YoStar/main/ja_JP/gamedata/excel/character_table.json",
    building:
      "https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData_YoStar/main/ja_JP/gamedata/excel/building_data.json"
  },
  en: {
    characters:
      "https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData_YoStar/main/en_US/gamedata/excel/character_table.json",
    building:
      "https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData_YoStar/main/en_US/gamedata/excel/building_data.json"
  }
};

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.json();
}

function rarityToNumber(rawRarity) {
  if (typeof rawRarity === "number") {
    return Math.min(6, Math.max(1, rawRarity + 1));
  }
  const match = String(rawRarity).match(/\d+/);
  return match ? Math.min(6, Math.max(1, Number(match[0]))) : 1;
}

function professionToJa(profession) {
  const map = {
    PIONEER: "先鋒",
    WARRIOR: "前衛",
    TANK: "重装",
    SNIPER: "狙撃",
    CASTER: "術師",
    MEDIC: "医療",
    SUPPORT: "補助",
    SPECIAL: "特殊"
  };
  return map[profession] ?? "その他";
}

function phaseToElite(phase) {
  const text = String(phase ?? "PHASE_0");
  const match = text.match(/\d+/);
  return Math.min(2, Math.max(0, match ? Number(match[0]) : 0));
}

function conditionLevelToNumber(level) {
  const numericLevel = Number(level);
  return Number.isFinite(numericLevel) ? Math.max(1, Math.trunc(numericLevel)) : 1;
}

function roomTypeToFacility(roomType) {
  switch (String(roomType ?? "").toUpperCase()) {
    case "MANUFACTURE":
      return "factory";
    case "TRADING":
      return "trading";
    case "POWER":
      return "power";
    case "CONTROL":
      return "control";
    case "DORMITORY":
      return "dormitory";
    case "MEETING":
      return "reception";
    default:
      return null;
  }
}

function inferProductFromDescription(description, roomType) {
  const text = String(description);
  if (roomType === "MEETING") return "clue";
  if (/源石|Originium/i.test(text)) return "originium";
  if (/贵金属|赤金|金属|纯金|gold/i.test(text)) return "gold";
  if (/作战记录|战斗记录|经验|Battle Record|EXP/i.test(text)) return "battleRecord";
  if (/龙门币|订单|贸易站|LMD|order/i.test(text)) return "lmd";
  if (/无人机|发电站|drone|power/i.test(text) || roomType === "POWER") return "power";
  if (/心情|恢复|宿舍|morale|dorm/i.test(text) || roomType === "DORMITORY") return "morale";
  return undefined;
}

function inferProduct(description, roomType) {
  const normalizedRoomType = String(roomType ?? "").toUpperCase();
  const product = inferProductFromDescription(description, roomType);
  if (normalizedRoomType === "MANUFACTURE") {
    if (product === "morale") {
      return /生产力|製造効率|productivity|production|仓库容量|保管上限|capacity limit/i.test(String(description))
        ? undefined
        : product;
    }
    return product === "gold" || product === "battleRecord" || product === "originium" ? product : undefined;
  }
  if (normalizedRoomType === "TRADING") {
    if (product === "morale") {
      return /订单上限|受注上限|order limit/i.test(String(description)) ? undefined : product;
    }
    return product === "lmd" ? product : undefined;
  }
  return product;
}

function inferEfficiency(description) {
  const positivePercentages = positivePercentagesFromDescription(description);
  if (positivePercentages.length > 1 && /额外|追加|additional|additionally|extra/i.test(String(description))) {
    return positivePercentages.reduce((sum, value) => sum + value, 0) / 100;
  }
  const positive = positivePercentages[0];
  return positive ? positive / 100 : 0;
}

function inferBaseEfficiency(description) {
  const positive = positivePercentagesFromDescription(description)[0];
  return positive ? positive / 100 : 0;
}

function positivePercentagesFromDescription(description) {
  const percentages = [...String(description).matchAll(/([+-]?\d+(?:\.\d+)?)%/g)].map((match) => Number(match[1]));
  return percentages.filter((value) => value > 0);
}

function cleanDescription(description) {
  return String(description ?? "")
    .replace(/<@[^>]+>/g, "")
    .replace(/<\$[^>]+>/g, "")
    .replace(/<\/>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function localizedText(languages, getter, fallback) {
  const localized = {};

  for (const [language, dataset] of Object.entries(languages)) {
    const value = getter(dataset);
    if (typeof value === "string" && value.trim()) {
      localized[language] = value.trim();
    }
  }

  if (!localized.zh && fallback) {
    localized.zh = fallback;
  }

  return localized;
}

function localizedDescription(languages, getter, fallback) {
  return localizedText(languages, (dataset) => cleanDescription(getter(dataset)), fallback);
}

async function loadNameOverrides() {
  try {
    return JSON.parse(await readFile(nameOverridesPath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function loadBaseSkillOverrides() {
  try {
    return JSON.parse(await readFile(baseSkillOverridesPath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function loadBaseSkillLocalizationOverrides() {
  try {
    return JSON.parse(await readFile(baseSkillLocalizationOverridesPath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function loadBaseSkillLocalizationFallbacks() {
  try {
    return JSON.parse(await readFile(baseSkillLocalizationFallbacksPath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function applyNameOverrides(name, overrides) {
  if (!overrides) {
    return name;
  }

  return Object.fromEntries(
    Object.entries({ ...name, ...overrides }).filter(([, value]) => typeof value === "string" && value.trim())
  );
}

function applyLocalizedOverrides(text, overrides) {
  return Object.fromEntries(
    Object.entries({ ...text, ...overrides }).filter(([, value]) => typeof value === "string" && value.trim())
  );
}

function applyLocalizedFallbacks(text, fallbacks) {
  return Object.fromEntries(
    Object.entries({ ...fallbacks, ...text }).filter(([, value]) => typeof value === "string" && value.trim())
  );
}

function preferredText(text) {
  return text.zh ?? text.ja ?? text.en ?? "";
}

function characterAffiliations(character) {
  return [character.nationId, character.groupId, character.teamId].filter(Boolean);
}

function buildNameIndex(languages) {
  const index = new Map();

  for (const [charId, character] of Object.entries(languages.zh.characters)) {
    for (const language of Object.keys(languages)) {
      const name = languages[language].characters[charId]?.name;
      if (typeof name === "string" && name.trim()) {
        index.set(name.trim(), charId);
      }
    }
    if (character?.name) {
      index.set(String(character.name).trim(), charId);
    }
  }

  return [...index.entries()].sort((a, b) => b[0].length - a[0].length);
}

const facilityPhraseMap = [
  { facility: "factory", phrases: ["製造所", "Factory", "制造站"] },
  { facility: "trading", phrases: ["貿易所", "Trading Post", "贸易站"] },
  { facility: "power", phrases: ["発電所", "Power Plant", "发电站"] },
  { facility: "control", phrases: ["制御中枢", "Control Center", "控制中枢"] },
  { facility: "dormitory", phrases: ["宿舎", "Dormitory", "宿舍"] },
  { facility: "reception", phrases: ["応接室", "Reception Room", "会客室"] }
];

const affiliationPhraseMap = [
  { affiliations: ["sami"], phrases: ["Sami"] },
  { affiliations: ["durin"], phrases: ["Durin"] },
  { affiliations: ["rainbow"], phrases: ["レインボー小隊", "Rainbow", "彩虹小队"] },
  { affiliations: ["student"], phrases: ["ウルサス学生自治団", "Ursus Student Self-Governing Group", "乌萨斯学生自治团"] },
  { affiliations: ["lgd"], phrases: ["龍門近衛局", "L.G.D.", "龙门近卫局"] },
  { affiliations: ["lee"], phrases: ["リー探偵事務所", "Lee's Detective Agency", "鲤氏侦探事务所"] },
  { affiliations: ["karlan"], phrases: ["カランド貿易", "Karlan Trade", "喀兰贸易"] },
  { affiliations: ["glasgow"], phrases: ["グラスゴー", "Glasgow", "格拉斯哥"] },
  { affiliations: ["rhine"], phrases: ["ライン生命", "Rhine Lab", "莱茵生命"] },
  { affiliations: ["laterano"], phrases: ["ラテラーノ", "Laterano", "拉特兰"] },
  { affiliations: ["pinus"], phrases: ["レッドパイン騎士団", "Pinus Sylvestris", "红松骑士团"] },
  { affiliations: ["sui"], phrases: ["歳", "Sui", "岁"] },
  { affiliations: ["abyssal"], phrases: ["アビサルハンター", "Abyssal Hunter", "深海猎人"] },
  { affiliations: ["blacksteel"], phrases: ["BSW", "Blacksteel", "黑钢"] }
];

function inferConditions(localizedDescription, nameIndex, currentCharId) {
  const texts = Object.values(localizedDescription).filter(Boolean);
  const conditions = [];

  for (const [name, charId] of nameIndex) {
    if (charId === currentCharId) {
      continue;
    }

    for (const { facility, phrases } of facilityPhraseMap) {
      if (
        texts.some((text) =>
          phrases.some(
            (phrase) =>
              hasNamePhrase(text, name, `と同じ${phrase}`) ||
              hasNamePhrase(text, name, `と同じ${phrase}に配置`) ||
              hasNamePhrase(text, name, ` is assigned to the same ${phrase}`) ||
              hasNamePhrase(text, name, ` assigned to the same ${phrase}`) ||
              text.includes(`与${name}同时进驻同个${phrase}`)
          )
        )
      ) {
        conditions.push({ type: "sameFacilityOperator", operatorIds: [charId] });
      } else if (
        texts.some((text) =>
          phrases.some(
            (phrase) =>
              hasNamePhrase(text, name, `が${phrase}に配置されている場合`) ||
              hasNamePhrase(text, name, `が${phrase}に配属されている場合`) ||
              hasNamePhrase(text, name, ` is assigned to a ${phrase}`) ||
              hasNamePhrase(text, name, ` is assigned to the ${phrase}`) ||
              text.includes(`${name}进驻${phrase}`)
          )
        )
      ) {
        conditions.push({ type: "facilityOperator", facility, operatorIds: [charId] });
      }
    }
  }

  for (const { affiliations, phrases } of affiliationPhraseMap) {
    for (const { facility, phrases: facilityPhrases } of facilityPhraseMap) {
      if (
        texts.some((text) =>
          phrases.some((affiliationPhrase) =>
            facilityPhrases.some(
              (facilityPhrase) =>
                text.includes(`同じ${facilityPhrase}に配置されている${affiliationPhrase}`) ||
                text.includes(`${affiliationPhrase} assigned to the same ${facilityPhrase}`) ||
                text.includes(`assigned together with another ${affiliationPhrase} Operator`)
            )
          )
        )
      ) {
        conditions.push({ type: "sameFacilityAffiliation", affiliations, min: 1 });
      } else if (
        texts.some((text) =>
          phrases.some((affiliationPhrase) =>
            facilityPhrases.some(
              (facilityPhrase) =>
                text.includes(`${facilityPhrase}に配置されている${affiliationPhrase}`) ||
                text.includes(`${facilityPhrase}に配置された${affiliationPhrase}`) ||
                text.includes(`${affiliationPhrase} Operator is assigned to a ${facilityPhrase}`) ||
                text.includes(`${affiliationPhrase} Operators assigned to ${facilityPhrase}`)
            )
          )
        )
      ) {
        conditions.push({ type: "facilityAffiliation", facility, affiliations, min: 1 });
      }
    }

    const grantsSpecialAffiliationBonus = texts.some((text) => /gain Special Bonuses|特殊効果|特殊加成/i.test(text));
    if (
      !grantsSpecialAffiliationBonus &&
      texts.some((text) =>
        phrases.some(
          (affiliationPhrase) =>
            text.includes(`基地内`) && text.includes(affiliationPhrase) ||
            text.includes(`base`) && text.includes(affiliationPhrase)
        )
      )
    ) {
      conditions.push({ type: "facilityAffiliation", affiliations, min: 1 });
    }
  }

  return dedupeConditions(conditions);
}

function inferScaling(localizedDescription) {
  const texts = Object.values(localizedDescription).filter(Boolean);

  for (const { affiliations, phrases } of affiliationPhraseMap) {
    for (const { facility, phrases: facilityPhrases } of facilityPhraseMap) {
      if (
        texts.some((text) =>
          phrases.some((affiliationPhrase) =>
            facilityPhrases.some(
              (facilityPhrase) =>
                text.includes(`each Operator from ${affiliationPhrase}`) && text.includes(facilityPhrase)
            )
          )
        )
      ) {
        return { type: "affiliation", affiliations, facility, includeSelf: true };
      }
    }
  }

  return undefined;
}

function hasNamePhrase(text, name, suffix) {
  let start = 0;
  const needle = `${name}${suffix}`;

  while (start < text.length) {
    const index = text.indexOf(needle, start);
    if (index === -1) {
      return false;
    }
    const previous = index > 0 ? text[index - 1] : "";
    if (!previous || !/[\p{Script=Katakana}\p{Script=Hiragana}\p{Script=Han}A-Za-z0-9]/u.test(previous)) {
      return true;
    }
    start = index + 1;
  }

  return false;
}

function dedupeConditions(conditions) {
  const seen = new Set();
  return conditions.filter((condition) => {
    const key = JSON.stringify(condition);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function referencedOperatorIdsFromEffect(effect) {
  const conditions = [
    ...(effect.conditions ?? []),
    ...(effect.conditionalBonuses ?? []).flatMap((bonus) => bonus.conditions ?? [])
  ];

  return conditions.flatMap((condition) => ("operatorIds" in condition ? condition.operatorIds : []));
}

function inferBaseSkillFamilies(name) {
  const names = Object.values(name ?? {}).join(" ");
  if (/Rhine Tech|ラインテク|莱茵科技/i.test(names)) return ["rhineTech"];
  if (/Pinus Sylvestris|レッドパイン|红松骑士团/i.test(names)) return ["pinusSylvestris"];
  if (/Standardization|標準化|标准化/i.test(names)) return ["standardization"];
  return [];
}

function normalize(
  languages,
  nameOverrides,
  baseSkillOverrides,
  baseSkillLocalizationOverrides,
  baseSkillLocalizationFallbacks
) {
  const characters = languages.zh.characters;
  const building = languages.zh.building;
  const buildingChars = building.chars ?? {};
  const buffs = building.buffs ?? {};
  const nameIndex = buildNameIndex(languages);

  const normalizedOperators = Object.entries(characters)
    .filter(([, character]) => character?.name && !character.isNotObtainable)
    .map(([charId, character]) => {
      const buildingEntry = buildingChars[charId] ?? {};
      const rawBuffs = Array.isArray(buildingEntry.buffChar)
        ? buildingEntry.buffChar.flatMap((group, slot) =>
            (group.buffData ?? []).map((rawBuff) => ({ ...rawBuff, slot }))
          )
        : [];
      const skills = rawBuffs
        .map((rawBuff, index) => {
          const buff = buffs[rawBuff.buffId];
          if (!buff) return null;

          const facility = roomTypeToFacility(buff.roomType);
          if (!facility) return null;

          const description = cleanDescription(buff.description);
          const localizedBuffName = localizedText(
            languages,
            (dataset) => dataset.building.buffs?.[rawBuff.buffId]?.buffName,
            buff.buffName ?? "基地スキル"
          );
          const localizedBuffDescription = localizedDescription(
            languages,
            (dataset) => dataset.building.buffs?.[rawBuff.buffId]?.description,
            description
          );
          const localizationOverride = baseSkillLocalizationOverrides[charId]?.skills?.[rawBuff.buffId];
          const localizationFallback = baseSkillLocalizationFallbacks[charId]?.skills?.[rawBuff.buffId];
          const overriddenBuffName = applyLocalizedOverrides(
            applyLocalizedFallbacks(localizedBuffName, localizationFallback?.name),
            localizationOverride?.name
          );
          const overriddenBuffDescription = applyLocalizedOverrides(
            applyLocalizedFallbacks(localizedBuffDescription, localizationFallback?.description),
            localizationOverride?.description
          );
          const conditions = inferConditions(overriddenBuffDescription, nameIndex, charId);
          const scaling = inferScaling(overriddenBuffDescription);
          const efficiency = inferEfficiency(description);
          const baseEfficiency = inferBaseEfficiency(description);
          const effectBase = {
            facility,
            product: inferProduct(description, buff.roomType),
            tags: [facility, buff.skillIcon, buff.buffIcon].filter(Boolean),
            description: overriddenBuffDescription
          };
          const effects =
            conditions.length && baseEfficiency < efficiency
              ? [
                  {
                    ...effectBase,
                    efficiency: baseEfficiency,
                    ...(scaling ? { scaling } : {})
                  },
                  {
                    ...effectBase,
                    efficiency,
                    ...(scaling ? { scaling } : {}),
                    conditions
                  }
                ]
              : [
                  {
                    ...effectBase,
                    efficiency,
                    ...(scaling ? { scaling } : {}),
                    ...(conditions.length ? { conditions } : {})
                  }
                ];

          return {
            id: String(buff.buffId ?? `${charId}-base-${index}`),
            name: overriddenBuffName,
            ...(inferBaseSkillFamilies(overriddenBuffName).length
              ? { families: inferBaseSkillFamilies(overriddenBuffName) }
              : {}),
            slot: rawBuff.slot,
            unlockPhase: phaseToElite(rawBuff.cond?.phase),
            unlockLevel: conditionLevelToNumber(rawBuff.cond?.level),
            effects
          };
        })
        .filter(Boolean);

      return {
        id: charId,
        name: applyNameOverrides(
          localizedText(languages, (dataset) => dataset.characters[charId]?.name, character.name),
          nameOverrides[charId]
        ),
        affiliations: characterAffiliations(character),
        rarity: rarityToNumber(character.rarity),
        profession: professionToJa(character.profession),
        skills
      };
    });
  const overriddenOperators = applyBaseSkillOverrides(normalizedOperators, baseSkillOverrides).map((operator) => ({
    ...operator,
    skills: operator.skills.map((skill) => ({
      ...skill,
      effects: skill.effects.map(annotateMoraleEffects).map(markUnmodeledEffect).map(annotateTimeCurve)
    }))
  }));
  const referencedOperatorIds = new Set(
    overriddenOperators.flatMap((operator) =>
      operator.skills.flatMap((skill) => skill.effects.flatMap((effect) => referencedOperatorIdsFromEffect(effect)))
    )
  );

  return overriddenOperators
    .filter((operator) => operator.skills.length > 0 || referencedOperatorIds.has(operator.id))
    .sort((a, b) => preferredText(a.name).localeCompare(preferredText(b.name), "zh-Hans-CN"));
}

function applyBaseSkillOverrides(operators, overrides) {
  if (!overrides || !Object.keys(overrides).length) {
    return operators;
  }

  return operators.map((operator) => {
    const operatorOverride = overrides[operator.id];
    if (!operatorOverride) {
      return operator;
    }

    const skills = operator.skills.map((skill) => {
      const skillOverride = operatorOverride.skills?.[skill.id];
      if (!skillOverride) {
        return skill;
      }

      const effects = skill.effects.map((effect, index) => {
        const effectOverride = skillOverride.effects?.find((candidate) => candidate.index === index);
        if (!effectOverride) {
          return effect;
        }
        const patch = structuredClone(effectOverride.patch);
        if (
          effect.efficiency === 0 &&
          patch.efficiency === 0.05 &&
          (patch.storageLimit !== undefined || patch.orderLimit !== undefined)
        ) {
          delete patch.efficiency;
        }
        return { ...effect, ...patch };
      });

      return {
        ...skill,
        ...structuredClone(skillOverride.patch ?? {}),
        effects: [...effects, ...structuredClone(skillOverride.addEffects ?? [])]
      };
    });
    const addAffiliations = operatorOverride.addAffiliations ?? [];
    const affiliations = addAffiliations.length ? [...new Set([...(operator.affiliations ?? []), ...addAffiliations])] : operator.affiliations;

    return {
      ...operator,
      affiliations,
      skills
    };
  });
}

function markUnmodeledEffect(effect) {
  const hasModeledValue =
    effect.efficiency !== 0 ||
    (effect.baseEfficiency ?? 0) !== 0 ||
    Boolean(effect.storageLimit) ||
    Boolean(effect.orderLimit) ||
    Boolean(effect.orderState) ||
    Boolean(effect.globalEffect) ||
    Boolean(effect.resourceEffects?.length) ||
    Boolean(effect.skillFamilyConversions?.length) ||
    Boolean(effect.facilityCountBonuses?.length) ||
    Boolean(effect.tradingOrderEffects?.length) ||
    Boolean(effect.conditionalBonuses?.length) ||
    Boolean(effect.moraleEffects?.length) ||
    Boolean(effect.moraleExchange);
  if (hasModeledValue || effect.ignoredForOptimization) {
    return effect;
  }
  return {
    ...effect,
    ignoredForOptimization: true,
    unsupportedReason: effect.unsupportedReason ?? "effectNotModeled"
  };
}

function annotateMoraleEffects(effect) {
  if (effect.moraleEffects?.length) {
    return effect;
  }
  const description = effect.description?.en ?? "";
  if (!/morale/i.test(description)) {
    return effect;
  }
  const moraleEffects = [];
  const add = (type, target, amount, extra = {}) => {
    if (Number.isFinite(amount) && !moraleEffects.some((candidate) => candidate.type === type && candidate.target === target && candidate.amount === amount)) {
      moraleEffects.push({ type, target, amount, ...extra });
    }
  };
  const signed = "([+-]\\d+(?:\\.\\d+)?)";
  for (const match of description.matchAll(new RegExp(`self Morale (?:loss|consumed)(?: per hour)?(?: is)?(?: increased by| reduced by)? ${signed}`, "gi"))) {
    add("consumption", "self", Number(match[1]));
  }
  for (const match of description.matchAll(new RegExp(`Morale consumed (?:per|each) hour(?: is)?(?: increased by| reduced by)? ${signed}`, "gi"))) {
    add("consumption", "self", Number(match[1]));
  }
  for (const match of description.matchAll(new RegExp(`Morale consumed per hour by ${signed}`, "gi"))) {
    add("consumption", "self", Number(match[1]));
  }
  for (const match of description.matchAll(new RegExp(`Morale (?:loss|consumed) of Operators in the [^,.]+ ${signed} per hour`, "gi"))) {
    add("consumption", "room", Number(match[1]));
  }
  for (const match of description.matchAll(new RegExp(`Morale consumed per hour of all Operators in the [^,.]+ ${signed}`, "gi"))) {
    add("consumption", "room", Number(match[1]));
  }
  for (const match of description.matchAll(new RegExp(`(?:increases the Morale consumption of Operators assigned to the [^,.]+ by|total Morale consumed is increased by) ${signed}`, "gi"))) {
    add("consumption", "room", Number(match[1]));
  }
  for (const match of description.matchAll(new RegExp(`Morale consumed when [^,.]+ is reduced by ${signed}`, "gi"))) {
    add("consumption", "self", Number(match[1]));
  }
  for (const match of description.matchAll(new RegExp(`reduces the Morale consumed each hour by ${signed}`, "gi"))) {
    add("consumption", "self", Number(match[1]));
  }
  for (const match of description.matchAll(new RegExp(`decreases own morale consumption by\\s*${signed}`, "gi"))) {
    add("consumption", "self", -Math.abs(Number(match[1])));
  }
  for (const match of description.matchAll(new RegExp(`Morale consumed per hour of all Operators \\(excluding self\\).*?${signed}`, "gi"))) {
    add("consumption", "other", Number(match[1]));
  }
  for (const match of description.matchAll(new RegExp(`self Morale recovered(?: per hour)? ${signed}`, "gi"))) {
    add("recovery", "self", Number(match[1]));
  }
  for (const match of description.matchAll(new RegExp(`self Morale restored per hour ${signed}`, "gi"))) {
    add("recovery", "self", Number(match[1]));
  }
  for (const match of description.matchAll(new RegExp(`restores ${signed} Morale per hour to all Operators`, "gi"))) {
    add("recovery", "room", Number(match[1]));
  }
  for (const match of description.matchAll(new RegExp(`restores ${signed} Morale per hour distributed evenly to Operators`, "gi"))) {
    add("recovery", "room", Number(match[1]));
  }
  for (const match of description.matchAll(new RegExp(`restores the Morale of all other Operators.*? by ${signed} per hour`, "gi"))) {
    add("recovery", "other", Number(match[1]));
  }
  for (const match of description.matchAll(new RegExp(`increases own Morale restored per hour by ${signed}`, "gi"))) {
    add("recovery", "self", Number(match[1]));
  }
  for (const match of description.matchAll(new RegExp(`increases (?:the )?Morale of all Operators.*? by ${signed} per hour`, "gi"))) {
    add("recovery", "room", Number(match[1]));
  }
  for (const match of description.matchAll(new RegExp(`Morale recovery per hour of all Operators in [^,.]+ ${signed}`, "gi"))) {
    add("recovery", "room", Number(match[1]));
  }
  for (const match of description.matchAll(new RegExp(`(?:increases|restores) (?:the )?Morale(?: recovery)? per hour of all Operators.*? by ${signed}`, "gi"))) {
    add("recovery", "room", Number(match[1]));
  }
  for (const match of description.matchAll(new RegExp(`restores ${signed} Morale per hour to (?:another|one other) Operator`, "gi"))) {
    add("recovery", "singleOther", Number(match[1]));
  }
  for (const match of description.matchAll(new RegExp(`restores ${signed} Morale per hour to all other Operators`, "gi"))) {
    add("recovery", "other", Number(match[1]));
  }
  for (const match of description.matchAll(new RegExp(`self and [^,.]+ Morale recovered per hour ${signed}`, "gi"))) {
    add("recovery", "self", Number(match[1]));
    add("recovery", "conditionOperators", Number(match[1]));
  }
  for (const match of description.matchAll(new RegExp(`all Operators in Dormitories recover ${signed} Morale per hour`, "gi"))) {
    add("recovery", "dormitories", Number(match[1]));
  }
  for (const match of description.matchAll(new RegExp(`Operators working in other (?:buildings|facilities) recover ${signed} Morale per hour`, "gi"))) {
    add("recovery", "otherFacilities", Number(match[1]));
  }
  for (const match of description.matchAll(new RegExp(`working Operators in certain facilities will recover ${signed} Morale per hour`, "gi"))) {
    add("recovery", "otherFacilities", Number(match[1]));
  }
  if (/ignore the effects of any Operators stationed in that Factory that would affect the Morale consumption of this Operator/i.test(description)) {
    add("immunity", "self", 0, { mode: "externalConsumptionEffects" });
  }
  if (/remove any Morale reduction effects from Sui Operators assigned to the Control Center that affect themselves/i.test(description)) {
    add("immunity", "conditionOperators", 0, {
      mode: "selfConsumptionReduction",
      affiliations: ["sui"]
    });
  }
  return moraleEffects.length ? { ...effect, moraleEffects } : effect;
}

function annotateTimeCurve(effect) {
  if (effect.timeCurve) {
    return effect;
  }
  const description = effect.description?.en ?? "";
  if (/Productivity \+30%\. For every 4 points of Morale difference on self, Productivity -5%/i.test(description)) {
    return {
      ...effect,
      moraleCurve: {
        initialEfficiency: 0.3,
        efficiencyPerStep: -0.05,
        moralePerStep: 4,
        minEfficiency: 0
      }
    };
  }
  if (/if own Morale difference is greater than 12, Productivity \+10%, storage capacity \+6/i.test(description)) {
    return {
      ...effect,
      activation: {
        type: "moraleSpent",
        threshold: 12
      }
    };
  }
  const firstHourMatch = description.match(
    /(?:productivity|drone recovery rate)(?: is)? \+?(\d+(?:\.\d+)?)% in the first hour and thereafter \+?(\d+(?:\.\d+)?)% per hour, up to \+?(\d+(?:\.\d+)?)%/i
  );
  const thenMatch = description.match(
    /(?:increases by|speed increases by) \+?(\d+(?:\.\d+)?)%,? then by another \+?(\d+(?:\.\d+)?)% per hour, up to (?:a )?maximum of \+?(\d+(?:\.\d+)?)%/i
  );
  const fromZeroMatch = description.match(
    /productivity per hour \+?(\d+(?:\.\d+)?)%, up to \+?(\d+(?:\.\d+)?)%/i
  );
  const match = firstHourMatch ?? thenMatch;
  if (match) {
    return {
      ...effect,
      timeCurve: {
        initialEfficiency: Number(match[1]) / 100,
        efficiencyPerHour: Number(match[2]) / 100,
        maxEfficiency: Number(match[3]) / 100,
        startsAfterFirstHour: true
      }
    };
  }
  if (fromZeroMatch) {
    return {
      ...effect,
      timeCurve: {
        initialEfficiency: 0,
        efficiencyPerHour: Number(fromZeroMatch[1]) / 100,
        maxEfficiency: Number(fromZeroMatch[2]) / 100
      }
    };
  }
  return effect;
}

const languages = Object.fromEntries(
  await Promise.all(
    Object.entries(sources).map(async ([language, languageSources]) => [
      language,
      {
        characters: await fetchJson(languageSources.characters),
        building: await fetchJson(languageSources.building)
      }
    ])
  )
);
const operators = normalize(
  languages,
  await loadNameOverrides(),
  await loadBaseSkillOverrides(),
  await loadBaseSkillLocalizationOverrides(),
  await loadBaseSkillLocalizationFallbacks()
);

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(operators, null, 2)}\n`, "utf8");
console.log(`Imported ${operators.length} operators into ${outputPath}`);
