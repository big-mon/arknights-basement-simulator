import { describe, expect, it } from "vitest";
import { applyWikiJapaneseLocalization } from "./wiki-localization-merge.mjs";

describe("applyWikiJapaneseLocalization", () => {
  it("refreshes wiki fallbacks without replacing official Japanese operator data", () => {
    const skill = {
      name: { ja: "公式スキル名" },
      effects: [{ description: { ja: "公式スキル説明" } }]
    };
    const fallback = {
      name: { ja: "旧Wikiスキル名" },
      description: { ja: "旧Wikiスキル説明" }
    };

    applyWikiJapaneseLocalization(skill, fallback, "新Wikiスキル名", "新Wikiスキル説明");

    expect(skill.name.ja).toBe("公式スキル名");
    expect(skill.effects[0].description.ja).toBe("公式スキル説明");
    expect(fallback.name.ja).toBe("新Wikiスキル名");
    expect(fallback.description.ja).toBe("新Wikiスキル説明");
  });

  it("fills missing Japanese operator data from the wiki fallback", () => {
    const skill = {
      name: { ja: "" },
      effects: [{ description: { ja: "" } }]
    };
    const fallback = {};

    applyWikiJapaneseLocalization(skill, fallback, "Wikiスキル名", "Wikiスキル説明");

    expect(skill.name.ja).toBe("Wikiスキル名");
    expect(skill.effects[0].description.ja).toBe("Wikiスキル説明");
    expect(fallback).toEqual({
      name: { ja: "Wikiスキル名" },
      description: { ja: "Wikiスキル説明" }
    });
  });
});
