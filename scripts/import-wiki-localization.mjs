import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const operatorsPath = path.join(root, "src", "data", "operators.json");
const nameOverridesPath = path.join(root, "src", "data", "operator-name-overrides.json");
const skillOverridesPath = path.join(root, "src", "data", "base-skill-localization-overrides.json");
const api = "https://arknights.wiki.gg/api.php";

async function wikiApi(parameters) {
  const url = new URL(api);
  for (const [key, value] of Object.entries({ ...parameters, format: "json", origin: "*" })) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, { headers: { "user-agent": "arknights-basement-localization-audit/1.0" } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

function decodeEntities(text) {
  const entities = { amp: "&", apos: "'", quot: '"', lt: "<", gt: ">", nbsp: " " };
  return text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (match, entity) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return entities[entity] ?? match;
  });
}

function plainText(wikitext) {
  return decodeEntities(
    wikitext
      .replace(/\[\[File:[^\]]+\]\]/gi, "")
      .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, "$1")
      .replace(/\[\[([^\]]+)\]\]/g, "$1")
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<[^>]+>/g, "")
      .replace(/'{2,}/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

async function pageTitleForOperator(operatorId) {
  const result = await wikiApi({ action: "query", list: "search", srsearch: `"${operatorId}"`, srlimit: "5" });
  return result.query?.search?.find((candidate) => candidate.title && !candidate.title.includes("/"))?.title;
}

async function englishSkill(skillId) {
  const result = await wikiApi({
    action: "expandtemplates",
    prop: "wikitext",
    text: `{{Base skills|id1=${skillId}}}`
  });
  const expanded = result.expandtemplates?.wikitext ?? "";
  const name = expanded.match(/<div class="skill-name"[^>]*>([\s\S]*?)<\/div>/i)?.[1];
  const description = expanded.match(/<td class="skill-description"[^>]*>([\s\S]*?)<\/td>/i)?.[1];
  return { name: name ? plainText(name) : "", description: description ? plainText(description) : "" };
}

const operators = JSON.parse(await readFile(operatorsPath, "utf8"));
const nameOverrides = JSON.parse(await readFile(nameOverridesPath, "utf8"));
let skillOverrides = {};
try {
  skillOverrides = JSON.parse(await readFile(skillOverridesPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

let importedNames = 0;
let importedSkills = 0;
for (const operator of operators) {
  const missingName = !operator.name.en?.trim();
  const missingSkills = operator.skills.filter(
    (skill) => !skill.name.en?.trim() || skill.effects.some((effect) => !effect.description.en?.trim())
  );
  if (!missingName && !missingSkills.length) continue;

  if (missingName) {
    const title = await pageTitleForOperator(operator.id);
    if (title) {
      nameOverrides[operator.id] = { ...(nameOverrides[operator.id] ?? {}), en: title };
      importedNames += 1;
    }
  }

  for (const skill of missingSkills) {
    const translated = await englishSkill(skill.id);
    if (!translated.name || !translated.description) {
      console.warn(`No complete wiki translation for ${operator.id}:${skill.id}`);
      continue;
    }
    const operatorOverride = (skillOverrides[operator.id] ??= { skills: {} });
    operatorOverride.skills[skill.id] = {
      name: { ...(operatorOverride.skills[skill.id]?.name ?? {}), en: translated.name },
      description: { ...(operatorOverride.skills[skill.id]?.description ?? {}), en: translated.description }
    };
    importedSkills += 1;
  }
}

await writeFile(nameOverridesPath, `${JSON.stringify(nameOverrides, null, 2)}\n`, "utf8");
await writeFile(skillOverridesPath, `${JSON.stringify(skillOverrides, null, 2)}\n`, "utf8");
console.log(`Imported ${importedNames} operator names and ${importedSkills} base-skill translations from ${api}`);
