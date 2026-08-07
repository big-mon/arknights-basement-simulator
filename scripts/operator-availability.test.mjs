import { describe, expect, it } from "vitest";
import { buildOperatorAvailabilitySnapshot, extractAvailableOperatorIds } from "./operator-availability.mjs";

describe("extractAvailableOperatorIds", () => {
  it("extracts only obtainable playable operators directly from the character table", () => {
    const characterTable = {
      char_warrior: { name: "Warrior", isNotObtainable: false, profession: "WARRIOR" },
      char_token: { name: "Token", isNotObtainable: false, profession: "TOKEN" },
      char_trap: { name: "Trap", isNotObtainable: false, profession: "TRAP" },
      char_npc: { name: "NPC", isNotObtainable: false, profession: "NPC" },
      char_unobtainable: { name: "Unobtainable", isNotObtainable: true, profession: "MEDIC" },
      char_empty_name: { name: "  ", isNotObtainable: false, profession: "CASTER" },
      token_not_character: { name: "Token", isNotObtainable: false, profession: "MEDIC" }
    };

    expect(extractAvailableOperatorIds(characterTable)).toEqual(["char_warrior"]);
  });

  it("accepts every playable profession and sorts IDs deterministically", () => {
    const characterTable = Object.fromEntries(
      ["SPECIAL", "SUPPORT", "MEDIC", "CASTER", "SNIPER", "TANK", "WARRIOR", "PIONEER"].map(
        (profession, index) => [
          `char_${String(8 - index).padStart(2, "0")}`,
          { name: profession, isNotObtainable: false, profession }
        ]
      )
    );

    expect(extractAvailableOperatorIds(characterTable)).toEqual([
      "char_01",
      "char_02",
      "char_03",
      "char_04",
      "char_05",
      "char_06",
      "char_07",
      "char_08"
    ]);
  });
});

describe("buildOperatorAvailabilitySnapshot", () => {
  it("builds JP and CN entries from local character tables without fetching", () => {
    const snapshot = buildOperatorAvailabilitySnapshot({
      regions: {
        JP: {
          characterTable: {
            char_shared: { name: "Shared", isNotObtainable: false, profession: "MEDIC" }
          },
          source: {
            url: "https://example.com/jp/character_table.json",
            commit: "7faf192d15eeac8b236c561a1938679f4642279e",
            observedAt: "2026-08-01T09:36:58Z"
          }
        },
        CN: {
          characterTable: {
            char_shared: { name: "Shared", isNotObtainable: false, profession: "MEDIC" },
            char_cn_only: { name: "CN only", isNotObtainable: false, profession: "SPECIAL" }
          },
          source: {
            url: "https://example.com/cn/character_table.json",
            commit: "81c6d458a1778a9ba878a95c4e6fe48fb4254041",
            observedAt: "2026-08-01T11:32:07Z"
          }
        }
      }
    });

    expect(snapshot).toEqual({
      schemaVersion: 1,
      regions: {
        JP: {
          source: expect.objectContaining({ commit: "7faf192d15eeac8b236c561a1938679f4642279e" }),
          operatorIds: ["char_shared"]
        },
        CN: {
          source: expect.objectContaining({ commit: "81c6d458a1778a9ba878a95c4e6fe48fb4254041" }),
          operatorIds: ["char_cn_only", "char_shared"]
        }
      }
    });
  });
});
