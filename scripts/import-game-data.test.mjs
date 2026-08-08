import { describe, expect, it } from "vitest";
import { normalize, roomTypeToFacility } from "./import-game-data.mjs";

const whisperainId = "char_436_whispr";
const memoryBuffId = "hire_spd_bd_n1_n1[100]";
const perceptionBuffId = "hire_spd_bd_n1[000]";

function syntheticLanguages({ characters, buffs, buffChars }) {
  return Object.fromEntries(["zh", "ja", "en"].map((language) => [language, {
    characters,
    building: {
      chars: buffChars,
      buffs
    }
  }]));
}

function fixedSourceLanguages() {
  const names = { zh: "絮雨", ja: "ウィスパーレイン", en: "Whisperain" };
  const descriptions = {
    zh: ["进驻人力办公室时，人脉资源的联络速度+20%，每个招募位（不包含初始招募位）+10记忆碎片", "进驻人力办公室时，每1点记忆碎片转化为1点感知信息"],
    ja: ["事務室配置時、事務連絡速度+20%、初期募集枠を除く募集枠1つにつき記憶の欠片+10", "事務室配置時、記憶の欠片1につき知覚情報1に転化"],
    en: ["When assigned to the HR Office, HR contacting speed +20%. For each recruitment slot excluding the initial slot, Memory Fragments +10", "When assigned to the HR Office, every 1 Memory Fragment is converted into 1 Perception Information"]
  };
  return Object.fromEntries(Object.entries(names).map(([language, name]) => [language, {
    characters: {
      [whisperainId]: { name, rarity: "TIER_5", profession: "MEDIC", nationId: "iberia" }
    },
    building: {
      chars: {
        [whisperainId]: {
          buffChar: [
            { buffData: [{ buffId: memoryBuffId, cond: { phase: "PHASE_0", level: 1 } }] },
            { buffData: [{ buffId: perceptionBuffId, cond: { phase: "PHASE_2", level: 1 } }] }
          ]
        }
      },
      buffs: {
        [memoryBuffId]: { buffId: memoryBuffId, roomType: "HIRE", buffName: "Memory", description: descriptions[language][0] },
        [perceptionBuffId]: { buffId: perceptionBuffId, roomType: "HIRE", buffName: "Perception", description: descriptions[language][1] }
      }
    }
  }]));
}

const overrides = {
  [whisperainId]: {
    skills: {
      [memoryBuffId]: {
        effects: [{ index: 0, patch: {
          resourceEffects: [{ resource: "memoryFragments", amount: 10, scaling: {
            type: "facilityRecruitmentSlots", excludedInitialSlots: 1
          } }]
        } }]
      },
      [perceptionBuffId]: {
        effects: [{ index: 0, patch: {
          resourceEffects: [{ resource: "perceptionInfo", amount: 1, scaling: {
            type: "resource", resource: "memoryFragments"
          } }]
        } }]
      }
    }
  }
};

describe("fixed-source game-data normalization", () => {
  it("maps the upstream HIRE room type to office", () => {
    expect(roomTypeToFacility("HIRE")).toBe("office");
  });

  it("retains canonical Whisperain names and source-backed office buffs", () => {
    const normalized = normalize(fixedSourceLanguages(), {}, overrides, {}, {});
    const whisperain = normalized.find((operator) => operator.id === whisperainId);

    expect(whisperain?.name).toEqual({ zh: "絮雨", ja: "ウィスパーレイン", en: "Whisperain" });
    expect(whisperain?.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: memoryBuffId,
        unlockPhase: 0,
        effects: [expect.objectContaining({
          facility: "office",
          efficiency: 0.2,
          resourceEffects: [{ resource: "memoryFragments", amount: 10, scaling: {
            type: "facilityRecruitmentSlots", excludedInitialSlots: 1
          } }]
        })]
      }),
      expect.objectContaining({
        id: perceptionBuffId,
        unlockPhase: 2,
        effects: [expect.objectContaining({
          facility: "office",
          resourceEffects: [{ resource: "perceptionInfo", amount: 1, scaling: {
            type: "resource", resource: "memoryFragments"
          } }]
        })]
      })
    ]));
  });

  it("excludes an unrelated HIRE-only operator without an explicit modeled override", () => {
    const operatorId = "char_unrelated_hire";
    const buffId = "hire_unmodeled[000]";
    const languages = syntheticLanguages({
      characters: {
        [operatorId]: { name: "Unrelated Hire", rarity: "TIER_4", profession: "MEDIC" }
      },
      buffs: {
        [buffId]: {
          buffId,
          roomType: "HIRE",
          buffName: "Unmodeled Office Skill",
          description: "When assigned to the HR Office, HR contacting speed +20%"
        }
      },
      buffChars: {
        [operatorId]: {
          buffChar: [{ buffData: [{ buffId, cond: { phase: "PHASE_0", level: 1 } }] }]
        }
      }
    });

    expect(normalize(languages, {}, {}, {}, {})).toEqual([]);
  });

  it("retains an ordinary supported skill while excluding an unoverridden HIRE skill", () => {
    const operatorId = "char_mixed_facilities";
    const powerBuffId = "power_supported[000]";
    const hireBuffId = "hire_unmodeled[001]";
    const languages = syntheticLanguages({
      characters: {
        [operatorId]: { name: "Mixed Facilities", rarity: "TIER_4", profession: "MEDIC" }
      },
      buffs: {
        [hireBuffId]: {
          buffId: hireBuffId,
          roomType: "HIRE",
          buffName: "Unmodeled Office Skill",
          description: "When assigned to the HR Office, HR contacting speed +20%"
        },
        [powerBuffId]: {
          buffId: powerBuffId,
          roomType: "POWER",
          buffName: "Power Skill",
          description: "When assigned to a Power Plant, drone recovery rate +10%"
        }
      },
      buffChars: {
        [operatorId]: {
          buffChar: [
            { buffData: [{ buffId: powerBuffId, cond: { phase: "PHASE_0", level: 1 } }] },
            { buffData: [{ buffId: hireBuffId, cond: { phase: "PHASE_1", level: 1 } }] }
          ]
        }
      }
    });

    const [operator] = normalize(languages, {}, {}, {}, {});

    expect(operator.id).toBe(operatorId);
    expect(operator.skills.map((skill) => skill.id)).toEqual([powerBuffId]);
    expect(operator.skills[0].effects[0].facility).toBe("power");
  });

  it("is deterministic when synthetic character and buff input order is reversed", () => {
    const characterEntries = [
      ["char_zulu", { name: "Zulu", rarity: "TIER_3", profession: "MEDIC" }],
      ["char_alpha", { name: "Alpha", rarity: "TIER_4", profession: "WARRIOR" }]
    ];
    const buffEntries = [
      ["power_zulu[000]", {
        buffId: "power_zulu[000]",
        roomType: "POWER",
        buffName: "Zulu Power",
        description: "When assigned to a Power Plant, drone recovery rate +10%"
      }],
      ["manufacture_alpha[000]", {
        buffId: "manufacture_alpha[000]",
        roomType: "MANUFACTURE",
        buffName: "Alpha Factory",
        description: "When assigned to a Factory, productivity +15%"
      }]
    ];
    const buffChars = {
      char_zulu: {
        buffChar: [{ buffData: [{ buffId: "power_zulu[000]", cond: { phase: "PHASE_0", level: 1 } }] }]
      },
      char_alpha: {
        buffChar: [{ buffData: [{ buffId: "manufacture_alpha[000]", cond: { phase: "PHASE_0", level: 1 } }] }]
      }
    };
    const normalizeEntries = (characters, buffs) => normalize(
      syntheticLanguages({ characters: Object.fromEntries(characters), buffs: Object.fromEntries(buffs), buffChars }),
      {},
      {},
      {},
      {}
    );

    const forward = normalizeEntries(characterEntries, buffEntries);
    const reversed = normalizeEntries([...characterEntries].reverse(), [...buffEntries].reverse());

    expect(forward.map((operator) => operator.id)).toEqual(["char_alpha", "char_zulu"]);
    expect(reversed).toEqual(forward);
  });
});
