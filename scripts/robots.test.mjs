// @vitest-environment node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("robots.txt", () => {
  it("allows all declared uses for the whole site in the global block", async () => {
    const robotsSource = await readFile(path.join(process.cwd(), "public", "robots.txt"), "utf8");
    const globalBlock = robotsSource
      .replaceAll("\r\n", "\n")
      .split(/\n\s*\n/)
      .find((block) => /^User-agent: \*$/m.test(block));
    const block = globalBlock ?? "";

    expect(block.match(/^User-agent: \*$/gm)).toEqual(["User-agent: *"]);
    expect(block.match(/^Content-Signal: .*$/gm)).toEqual([
      "Content-Signal: ai-train=yes, search=yes, ai-input=yes"
    ]);
    expect(block.match(/^Allow: \/$/gm)).toEqual(["Allow: /"]);
  });
});
