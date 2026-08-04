import { describe, expect, it } from "vitest";
import { buildOperatorAvailabilitySnapshot, extractAvailableOperatorIds } from "./operator-availability.mjs";

describe("extractAvailableOperatorIds", () => {
  it("intersects a character table with the checked-in catalog in catalog order", () => {
    const characterTable = {
      char_cn_only: { name: "CN only" },
      char_shared: { name: "Shared" },
      char_not_in_catalog: { name: "Ignored" }
    };

    expect(extractAvailableOperatorIds(characterTable, ["char_shared", "char_cn_only", "char_missing"])).toEqual([
      "char_shared",
      "char_cn_only"
    ]);
  });
});

describe("buildOperatorAvailabilitySnapshot", () => {
  it("builds JP and CN entries from local character tables without fetching", () => {
    const snapshot = buildOperatorAvailabilitySnapshot({
      catalogOperatorIds: ["char_shared", "char_cn_only"],
      regions: {
        JP: {
          characterTable: { char_shared: { name: "Shared" } },
          source: {
            url: "https://example.com/jp/character_table.json",
            commit: "7faf192d15eeac8b236c561a1938679f4642279e",
            observedAt: "2026-08-01T09:36:58Z"
          }
        },
        CN: {
          characterTable: { char_shared: { name: "Shared" }, char_cn_only: { name: "CN only" } },
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
          operatorIds: ["char_shared", "char_cn_only"]
        }
      }
    });
  });
});
