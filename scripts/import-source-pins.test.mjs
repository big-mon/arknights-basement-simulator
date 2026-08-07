import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const importerSource = await readFile(path.join(process.cwd(), "scripts", "import-game-data.mjs"), "utf8");

describe("game-data importer source pins", () => {
  it("pins every raw GitHub source URL to a full commit SHA", () => {
    const urls = importerSource.match(/https:\/\/raw\.githubusercontent\.com\/[^\s"']+/g) ?? [];
    const refs = urls.map((url) => new URL(url).pathname.split("/")[3]);

    expect(urls.length).toBeGreaterThan(0);
    expect(refs).toEqual(refs.map(() => expect.stringMatching(/^[0-9a-f]{40}$/)));
  });
});
