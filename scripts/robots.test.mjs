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

  it("explicitly allows the required AI crawlers", async () => {
    const robotsSource = await readFile(path.join(process.cwd(), "public", "robots.txt"), "utf8");
    const blocks = robotsSource.replaceAll("\r\n", "\n").split(/\n\s*\n/);
    const requiredUserAgents = ["GPTBot", "OAI-SearchBot", "Claude-Web", "Google-Extended"];
    const explicitUserAgentLines = blocks.flatMap(
      (block) => block.match(/^User-agent: (?!\*$).+$/gm) ?? []
    );

    expect(explicitUserAgentLines).toHaveLength(requiredUserAgents.length);

    for (const userAgent of requiredUserAgents) {
      const userAgentLine = `User-agent: ${userAgent}`;
      const matchingBlocks = blocks.filter((block) => block.split("\n").includes(userAgentLine));

      expect(explicitUserAgentLines.filter((line) => line === userAgentLine)).toEqual([userAgentLine]);
      expect(matchingBlocks).toHaveLength(1);
      expect(matchingBlocks[0]?.match(/^Allow: \/$/gm)).toEqual(["Allow: /"]);
    }
  });
});
