import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outputPath = path.join(root, "src", "data", "operators.imported.json");
const sources = {
  characters:
    "https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/ja_JP/gamedata/excel/character_table.json",
  building:
    "https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/ja_JP/gamedata/excel/building_data.json"
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

function roomTypeToFacility(roomType) {
  const text = String(roomType).toLowerCase();
  if (text.includes("manufact") || text.includes("factory")) return "factory";
  if (text.includes("trading")) return "trading";
  if (text.includes("power")) return "power";
  if (text.includes("control")) return "control";
  if (text.includes("dorm")) return "dormitory";
  return null;
}

function inferProduct(description) {
  if (/純金|gold/i.test(description)) return "gold";
  if (/作戦記録|battle|record|exp/i.test(description)) return "battleRecord";
  if (/龍門幣|LMD|受注|注文|order/i.test(description)) return "lmd";
  if (/ドローン|発電|power/i.test(description)) return "power";
  if (/体力|回復|宿舎|morale/i.test(description)) return "morale";
  return undefined;
}

function inferEfficiency(description) {
  const percentages = [...String(description).matchAll(/([+-]?\d+)%/g)].map((match) => Number(match[1]));
  const positive = percentages.find((value) => value > 0);
  return positive ? positive / 100 : 0.05;
}

function normalize(characters, building) {
  const buildingChars = building.chars ?? {};
  const buffs = building.buffs ?? {};

  return Object.values(characters)
    .filter((character) => character?.name && !character.isNotObtainable)
    .map((character) => {
      const buildingEntry = buildingChars[character.charId] ?? buildingChars[character.id] ?? {};
      const rawBuffs = Array.isArray(buildingEntry.buffChar) ? buildingEntry.buffChar.flat(4) : [];
      const skills = rawBuffs
        .map((rawBuff, index) => {
          const buffId = rawBuff.buffId ?? rawBuff.buffData?.buffId ?? rawBuff.id;
          const buff = buffs[buffId] ?? rawBuff;
          const description = buff.description ?? buff.desc ?? buff.buffName ?? "";
          const facility = roomTypeToFacility(buff.roomType ?? buff.buffRoomType ?? rawBuff.roomType);
          if (!facility) return null;

          const unlockPhase = Number(rawBuff.cond?.phase ?? rawBuff.unlockPhase ?? 0);
          return {
            id: String(buffId ?? `${character.charId}-base-${index}`),
            name: buff.buffName ?? buff.name ?? "基地スキル",
            unlockPhase: Math.min(2, Math.max(0, unlockPhase)),
            effects: [
              {
                facility,
                product: inferProduct(description),
                efficiency: inferEfficiency(description),
                tags: [facility],
                description
              }
            ]
          };
        })
        .filter(Boolean);

      return {
        id: character.charId,
        name: character.name,
        rarity: rarityToNumber(character.rarity),
        profession: professionToJa(character.profession),
        skills
      };
    })
    .filter((operator) => operator.skills.length > 0);
}

const [characters, building] = await Promise.all([fetchJson(sources.characters), fetchJson(sources.building)]);
const operators = normalize(characters, building);

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(operators, null, 2), "utf8");
console.log(`Imported ${operators.length} operators into ${outputPath}`);
