import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outputPath = path.join(root, "src", "data", "operators.json");
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
  return match ? Math.min(6, Math.max(1, Number(match[0]) + 1)) : 1;
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
    default:
      return null;
  }
}

function inferProduct(description, roomType) {
  const text = String(description);
  if (/贵金属|赤金|金属|纯金|gold/i.test(text)) return "gold";
  if (/作战记录|战斗记录|经验|Battle Record|EXP/i.test(text)) return "battleRecord";
  if (/龙门币|订单|贸易站|LMD|order/i.test(text)) return "lmd";
  if (/无人机|发电站|drone|power/i.test(text) || roomType === "POWER") return "power";
  if (/心情|恢复|宿舍|morale|dorm/i.test(text) || roomType === "DORMITORY") return "morale";
  return undefined;
}

function inferEfficiency(description) {
  const percentages = [...String(description).matchAll(/([+-]?\d+(?:\.\d+)?)%/g)].map((match) => Number(match[1]));
  const positive = percentages.find((value) => value > 0);
  return positive ? positive / 100 : 0.05;
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

function preferredText(text) {
  return text.zh ?? text.ja ?? text.en ?? "";
}

function normalize(languages) {
  const characters = languages.zh.characters;
  const building = languages.zh.building;
  const buildingChars = building.chars ?? {};
  const buffs = building.buffs ?? {};

  return Object.entries(characters)
    .filter(([, character]) => character?.name && !character.isNotObtainable && !character.isSpChar)
    .map(([charId, character]) => {
      const buildingEntry = buildingChars[charId] ?? {};
      const rawBuffs = Array.isArray(buildingEntry.buffChar)
        ? buildingEntry.buffChar.flatMap((group) => group.buffData ?? [])
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

          return {
            id: String(buff.buffId ?? `${charId}-base-${index}`),
            name: localizedBuffName,
            unlockPhase: phaseToElite(rawBuff.cond?.phase),
            effects: [
              {
                facility,
                product: inferProduct(description, buff.roomType),
                efficiency: inferEfficiency(description),
                tags: [facility, buff.skillIcon, buff.buffIcon].filter(Boolean),
                description: localizedBuffDescription
              }
            ]
          };
        })
        .filter(Boolean);

      return {
        id: charId,
        name: localizedText(languages, (dataset) => dataset.characters[charId]?.name, character.name),
        rarity: rarityToNumber(character.rarity),
        profession: professionToJa(character.profession),
        skills
      };
    })
    .filter((operator) => operator.skills.length > 0)
    .sort((a, b) => preferredText(a.name).localeCompare(preferredText(b.name), "zh-Hans-CN"));
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
const operators = normalize(languages);

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(operators, null, 2)}\n`, "utf8");
console.log(`Imported ${operators.length} operators into ${outputPath}`);
