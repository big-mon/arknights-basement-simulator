import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyWikiJapaneseLocalization } from "./wiki-localization-merge.mjs";

const root = process.cwd();
const operatorsPath = path.join(root, "src", "data", "operators.json");
const overridesPath = path.join(root, "src", "data", "base-skill-localization-overrides.json");
const fallbacksPath = path.join(root, "src", "data", "base-skill-localization-fallbacks.json");
const nameFallbacksPath = path.join(root, "src", "data", "base-skill-japanese-name-fallbacks.json");
const wiki = "https://arknights.wikiru.jp/";

function decodeEntities(text) {
  const named = { amp: "&", apos: "'", quot: '"', lt: "<", gt: ">", nbsp: " ", ensp: " " };
  return text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (match, entity) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity] ?? match;
  });
}

function plainText(wikitext) {
  let text = wikitext;
  let previous;
  do {
    previous = text;
    text = text
      .replace(/&color\([^)]*\)\{([^{}]*)\};/gi, "$1")
      .replace(/&tooltip\(([^,);]+)(?:,[^)]*)?\);/gi, "$1")
      .replace(/\[\[&ref\([^\]]+\);>([^\]]+)\]\]/gi, "$1")
      .replace(/\[\[([^\]|>]+)\|([^\]]+)\]\]/g, "$2")
      .replace(/\[\[([^\]>]+)>([^\]]+)\]\]/g, "$1")
      .replace(/\[\[([^\]]+)\]\]/g, "$1");
  } while (text !== previous);

  return decodeEntities(text)
    .replace(/&br;/gi, " ")
    .replace(/&ensp;/gi, " ")
    .replace(/&[^;\s]+;/g, "")
    .replace(/'{2,}/g, "")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .replace(/^~/, "")
    .replace(/\s*[（(][^）)]*から変化[）)]$/, "")
    .trim();
}

function facilityFromDescription(description) {
  const facilities = [
    ["貿易所", "trading"],
    ["製造所", "factory"],
    ["発電所", "power"],
    ["制御中枢", "control"],
    ["応接室", "reception"],
    ["事務室", "office"],
    ["訓練室", "training"],
    ["宿舎", "dormitory"],
    ["加工所", "workshop"]
  ];
  return facilities.find(([label]) => description.includes(label))?.[1];
}

function sourceFromHtml(html) {
  const match = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  return match ? decodeEntities(match[1]) : "";
}

function baseSkillRows(source) {
  const heading = source.match(/^\*\*基地スキル[^\n]*\n/m);
  if (!heading) return [];
  const tail = source.slice(heading.index + heading[0].length);
  const nextHeading = tail.search(/^\*\*[^*]/m);
  const section = nextHeading >= 0 ? tail.slice(0, nextHeading) : tail;

  let previousName = "";
  return section
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|") && !/^[|:A-Z0-9]+c$/i.test(line))
    .map((line) => line.slice(1, line.endsWith("|") ? -1 : undefined).split("|"))
    .filter((cells) => cells.length >= 3)
    .map(([name, unlock, ...description]) => {
      const parsedName = name === "~" ? previousName : plainText(name);
      if (parsedName && parsedName !== "名称") previousName = parsedName;
      const parsedDescription = plainText(description.join("|"));
      return {
        name: parsedName,
        unlock: plainText(unlock),
        description: parsedDescription,
        facility: facilityFromDescription(parsedDescription)
      };
    })
    .filter((row) => row.name && row.description && row.name !== "名称");
}

function unlockKey(skill) {
  return `${skill.unlockPhase ?? 0}:${skill.unlockLevel ?? 1}`;
}

function wikiUnlockKey(unlock) {
  const elite = unlock.match(/昇進\s*([12])/);
  const level = unlock.match(/Lv\.?\s*(\d+)/i);
  return `${elite ? Number(elite[1]) : 0}:${level ? Number(level[1]) : 1}`;
}

function alignRows(operator, rows) {
  const unused = [...rows];
  return operator.skills.map((skill) => {
    const existingName = skill.name.ja?.trim();
    let index = existingName ? unused.findIndex((row) => row.name === existingName) : -1;
    if (index < 0) {
      const key = unlockKey(skill);
      const facility = skill.effects[0]?.facility;
      index = unused.findIndex((row) => row.facility === facility && wikiUnlockKey(row.unlock) === key);
    }
    if (index < 0) index = 0;
    return unused.splice(index, 1)[0];
  });
}

async function fetchWikiSource(pageTitle) {
  const url = new URL(wiki);
  url.searchParams.set("cmd", "source");
  url.searchParams.set("page", pageTitle);
  const response = await fetch(url, {
    headers: { "user-agent": "arknights-basement-japanese-localization/1.0" }
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return sourceFromHtml(await response.text());
}

const operators = JSON.parse(await readFile(operatorsPath, "utf8"));
const overrides = JSON.parse(await readFile(overridesPath, "utf8"));
const nameFallbacks = JSON.parse(await readFile(nameFallbacksPath, "utf8"));
let fallbacks;
let migrateJapaneseOverrides = false;
try {
  fallbacks = JSON.parse(await readFile(fallbacksPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  fallbacks = {};
  migrateJapaneseOverrides = true;
}

if (migrateJapaneseOverrides) {
  for (const [operatorId, operatorOverride] of Object.entries(overrides)) {
    for (const [skillId, skillOverride] of Object.entries(operatorOverride.skills ?? {})) {
      if (!skillOverride.name?.ja && !skillOverride.description?.ja) continue;
      const fallback = (((fallbacks[operatorId] ??= { skills: {} }).skills[skillId] ??= {}));
      if (skillOverride.name?.ja) {
        fallback.name = { ...(fallback.name ?? {}), ja: skillOverride.name.ja };
        delete skillOverride.name.ja;
        if (!Object.keys(skillOverride.name).length) delete skillOverride.name;
      }
      if (skillOverride.description?.ja) {
        fallback.description = { ...(fallback.description ?? {}), ja: skillOverride.description.ja };
        delete skillOverride.description.ja;
        if (!Object.keys(skillOverride.description).length) delete skillOverride.description;
      }
      if (!Object.keys(skillOverride).length) delete operatorOverride.skills[skillId];
    }
    if (!Object.keys(operatorOverride.skills ?? {}).length) delete overrides[operatorId];
  }
}
let importedSkills = 0;

for (const operator of operators) {
  const missing = operator.skills.some(
    (skill) => !skill.name.ja?.trim() || skill.effects.some((effect) => !effect.hiddenFromUi && !effect.description.ja?.trim())
  );
  const managed = operator.skills.some((skill) => {
    const fallback = fallbacks[operator.id]?.skills?.[skill.id];
    return fallback?.name?.ja || fallback?.description?.ja;
  });
  if (!missing && !managed) continue;

  const source = await fetchWikiSource(operator.name.ja);
  const rows = baseSkillRows(source);
  if (!rows.length) {
    console.warn(`No Japanese base-skill table for ${operator.id} (${operator.name.ja})`);
    continue;
  }

  const operatorForAlignment = {
    ...operator,
    skills: operator.skills.map((skill) => ({
      ...skill,
      name: fallbacks[operator.id]?.skills?.[skill.id]?.name?.ja ? { ...skill.name, ja: "" } : skill.name
    }))
  };
  const aligned = alignRows(operatorForAlignment, rows);
  for (const [index, skill] of operator.skills.entries()) {
    const row = aligned[index];
    const existingFallback = fallbacks[operator.id]?.skills?.[skill.id];
    const wikiManaged = existingFallback?.name?.ja || existingFallback?.description?.ja;
    if (
      !row ||
      (!wikiManaged && skill.name.ja?.trim() && skill.effects.every((effect) => effect.hiddenFromUi || effect.description.ja?.trim()))
    ) {
      continue;
    }

    const operatorFallback = (fallbacks[operator.id] ??= { skills: {} });
    const skillFallback = (operatorFallback.skills[skill.id] ??= {});
    const localizedName = nameFallbacks[operator.id]?.[skill.id] ?? row.name;
    applyWikiJapaneseLocalization(skill, skillFallback, localizedName, row.description);
    importedSkills += 1;
  }
}

if (migrateJapaneseOverrides) {
  await writeFile(overridesPath, `${JSON.stringify(overrides, null, 2)}\n`, "utf8");
}
await writeFile(fallbacksPath, `${JSON.stringify(fallbacks, null, 2)}\n`, "utf8");
await writeFile(operatorsPath, `${JSON.stringify(operators, null, 2)}\n`, "utf8");
console.log(`Imported Japanese localization for ${importedSkills} base skills from ${wiki}`);
