import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import operators from "./data/operators.json";
import { describe, expect, it } from "vitest";

describe("checked-in operator avatars", () => {
  it("has a non-empty PNG avatar for every catalog operator", () => {
    const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

    for (const operator of operators) {
      const avatar = readFileSync(resolve(process.cwd(), "public/operator-avatars", `${operator.id}.png`));

      expect(avatar.byteLength, `${operator.id} avatar should not be empty`).toBeGreaterThan(0);
      expect(Array.from(avatar.subarray(0, pngSignature.length)), `${operator.id} avatar should be PNG`).toEqual(pngSignature);
    }
  });
});
