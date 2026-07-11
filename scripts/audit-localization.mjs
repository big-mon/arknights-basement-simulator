import { readFile } from "node:fs/promises";
import path from "node:path";

const operators = JSON.parse(await readFile(path.join(process.cwd(), "src", "data", "operators.json"), "utf8"));
const issues = [];

for (const operator of operators) {
  for (const language of ["ja", "en"]) {
    if (!operator.name[language]?.trim()) {
      issues.push({ type: "operatorName", language, operatorId: operator.id });
    }
  }
  for (const skill of operator.skills) {
    for (const language of ["ja", "en"]) {
      if (!skill.name[language]?.trim()) {
        issues.push({ type: "skillName", language, operatorId: operator.id, skillId: skill.id });
      }
      for (const effect of skill.effects) {
        if (!effect.description[language]?.trim()) {
          issues.push({ type: "skillDescription", language, operatorId: operator.id, skillId: skill.id });
          break;
        }
      }
    }
  }
}

const counts = Object.fromEntries(
  [...new Set(issues.map((issue) => `${issue.type}.${issue.language}`))]
    .sort()
    .map((key) => [key, issues.filter((issue) => `${issue.type}.${issue.language}` === key).length])
);
console.log(
  JSON.stringify(
    { totals: { operators: operators.length }, counts, ...(process.argv.includes("--details") ? { issues } : {}) },
    null,
    2
  )
);
if (issues.length && process.argv.includes("--strict")) process.exitCode = 1;
