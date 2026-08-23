// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import worker from "./worker";

const markdown = "# アークナイツ基地ローテーションシミュレーター\n\n基地配置とローテーション案を確認できます。\n";
const html = "<!doctype html><html><body><div id=\"root\"></div></body></html>";

function createAssets() {
  const fetch = vi.fn(async (request: Request) => {
    if (new URL(request.url).pathname === "/site.md") {
      return new Response(markdown, {
        status: 200,
        headers: {
          "Cache-Control": "public, max-age=60",
          ETag: "markdown-etag",
          "Content-Type": "text/markdown"
        }
      });
    }

    return new Response(html, {
      status: 200,
      headers: {
        ETag: "html-etag",
        "Content-Type": "text/html; charset=UTF-8"
      }
    });
  });

  return { ASSETS: { fetch } };
}

describe("Worker Markdown negotiation", () => {
  it.each([
    "text/markdown",
    "text/html;q=0.8, text/markdown;q=0.9",
    "TEXT/MARKDOWN; q=0.5"
  ])("serves the checked-in Markdown representation for GET with Accept: %s", async (accept) => {
    const env = createAssets();
    const request = new Request("https://example.com/", {
      headers: { Accept: accept }
    });

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("Vary")).toBe("Accept");
    expect(response.headers.get("ETag")).toBe("markdown-etag");
    const body = await response.text();
    expect(body).toContain("# アークナイツ基地ローテーションシミュレーター");
    expect(body).not.toContain("<!doctype html>");
    expect(env.ASSETS.fetch).toHaveBeenCalledTimes(1);
    expect(new URL(env.ASSETS.fetch.mock.calls[0][0].url).pathname).toBe("/site.md");
  });

  it("preserves an upstream Vary: * header for Markdown", async () => {
    const env = {
      ASSETS: {
        fetch: vi.fn(async () => new Response(markdown, { headers: { Vary: "*" } }))
      }
    };
    const request = new Request("https://example.com/", {
      headers: { Accept: "text/markdown" }
    });

    const response = await worker.fetch(request, env);

    expect(response.headers.get("Vary")).toBe("*");
  });

  it.each([
    undefined,
    "*/*",
    "text/html, text/markdown;q=0",
    "text/markdown;q=0, */*;q=1"
  ])("keeps the static asset HTML response when Markdown is not acceptable (%s)", async (accept) => {
    const env = createAssets();
    const request = new Request("https://example.com/", accept ? { headers: { Accept: accept } } : undefined);

    const response = await worker.fetch(request, env);

    expect(response.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(await response.text()).toBe(html);
    expect(env.ASSETS.fetch).toHaveBeenCalledTimes(1);
    expect(env.ASSETS.fetch.mock.calls[0][0]).toBe(request);
  });

  it("serves Markdown headers without a body for HEAD", async () => {
    const env = createAssets();
    const request = new Request("https://example.com/", {
      method: "HEAD",
      headers: { Accept: "text/markdown" }
    });

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("Vary")).toBe("Accept");
    expect(await response.text()).toBe("");
  });

  it("delegates a HEAD page request when Markdown is not acceptable", async () => {
    const env = createAssets();
    const request = new Request("https://example.com/", {
      method: "HEAD",
      headers: { Accept: "text/markdown;q=0" }
    });

    const response = await worker.fetch(request, env);

    expect(response.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(env.ASSETS.fetch).toHaveBeenCalledTimes(1);
    expect(env.ASSETS.fetch.mock.calls[0][0]).toBe(request);
  });

  it("does not negotiate a static asset path", async () => {
    const env = createAssets();
    const request = new Request("https://example.com/assets/app.js", {
      headers: { Accept: "text/markdown" }
    });

    const response = await worker.fetch(request, env);

    expect(response.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
    expect(env.ASSETS.fetch.mock.calls[0][0]).toBe(request);
  });
});
