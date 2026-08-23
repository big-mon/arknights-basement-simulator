const MARKDOWN_ASSET_PATH = "/site.md";

export interface StaticAssets {
  fetch(request: Request): Promise<Response>;
}

export interface WorkerEnv {
  ASSETS: StaticAssets;
}

function qualityForParameters(parameters: string[]): number {
  const qualityParameter = parameters.find((parameter) => {
    const separator = parameter.indexOf("=");
    return separator > 0 && parameter.slice(0, separator).trim().toLowerCase() === "q";
  });

  if (!qualityParameter) {
    return 1;
  }

  const separator = qualityParameter.indexOf("=");
  const value = qualityParameter.slice(separator + 1).trim();
  const quality = Number(value);
  return Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0;
}

export function acceptsMarkdown(accept: string | null): boolean {
  if (!accept) {
    return false;
  }

  return accept.split(",").some((range) => {
    const [mediaType, ...parameters] = range.split(";");
    return mediaType.trim().toLowerCase() === "text/markdown" && qualityForParameters(parameters) > 0;
  });
}

export function isPageRequest(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }

  const pathname = new URL(request.url).pathname;
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  const extension = lastSegment.includes(".") ? lastSegment.slice(lastSegment.lastIndexOf(".")).toLowerCase() : "";

  return pathname === "/" || extension === "" || extension === ".html";
}

function addAcceptToVary(vary: string | null): string {
  if (!vary) {
    return "Accept";
  }

  if (vary.trim() === "*") {
    return vary;
  }

  if (vary.split(",").some((value) => value.trim().toLowerCase() === "accept")) {
    return vary;
  }

  return `${vary}, Accept`;
}

async function markdownResponse(request: Request, env: WorkerEnv): Promise<Response | undefined> {
  const markdownRequest = new Request(new URL(MARKDOWN_ASSET_PATH, request.url), request);
  const assetResponse = await env.ASSETS.fetch(markdownRequest);

  if (!assetResponse.ok) {
    return undefined;
  }

  const headers = new Headers(assetResponse.headers);
  headers.set("Content-Type", "text/markdown; charset=utf-8");
  headers.set("Vary", addAcceptToVary(headers.get("Vary")));

  return new Response(request.method === "HEAD" ? null : assetResponse.body, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers
  });
}

const worker = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    if (isPageRequest(request) && acceptsMarkdown(request.headers.get("Accept"))) {
      const response = await markdownResponse(request, env);
      if (response) {
        return response;
      }
    }

    return env.ASSETS.fetch(request);
  }
};

export default worker;
