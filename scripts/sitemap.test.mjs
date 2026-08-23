// @vitest-environment node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const PUBLIC_ROOT = path.join(process.cwd(), "public");
const CANONICAL_URL = "https://arknights.damonge.com/";
const SITEMAP_NAMESPACE = "http://www.sitemaps.org/schemas/sitemap/0.9";

async function readPublicFile(fileName) {
  return readFile(path.join(PUBLIC_ROOT, fileName), "utf8");
}

function readCanonicalUrls(indexSource) {
  const document = new JSDOM(indexSource).window.document;

  return [...document.querySelectorAll('link[rel="canonical"]')].map((link) =>
    link.getAttribute("href")
  );
}

function readSitemapUrls(sitemapSource) {
  const document = new JSDOM(sitemapSource, { contentType: "text/xml" }).window.document;
  const root = document.documentElement;

  expect(root.localName).toBe("urlset");
  expect(root.namespaceURI).toBe(SITEMAP_NAMESPACE);

  const urlElements = [...root.children];
  expect(urlElements.every((url) => url.localName === "url" && url.namespaceURI === SITEMAP_NAMESPACE)).toBe(
    true
  );

  return urlElements.map((url) => {
    const locElements = [...url.children].filter(
      (element) => element.localName === "loc" && element.namespaceURI === SITEMAP_NAMESPACE
    );
    expect(locElements).toHaveLength(1);
    return locElements[0].textContent?.trim();
  });
}

describe("sitemap.xml", () => {
  it("lists exactly the canonical public URL from index.html", async () => {
    const [indexSource, sitemapSource] = await Promise.all([
      readFile(path.join(process.cwd(), "index.html"), "utf8"),
      readPublicFile("sitemap.xml")
    ]);
    const canonicalUrls = readCanonicalUrls(indexSource);

    expect(canonicalUrls).toEqual([CANONICAL_URL]);
    expect(readSitemapUrls(sitemapSource)).toEqual(canonicalUrls);
  });

  it("advertises exactly one sitemap from robots.txt", async () => {
    const robotsSource = (await readPublicFile("robots.txt")).replaceAll("\r\n", "\n");

    expect(robotsSource.match(/^Sitemap: .*$/gm)).toEqual([
      "Sitemap: https://arknights.damonge.com/sitemap.xml"
    ]);
  });
});
