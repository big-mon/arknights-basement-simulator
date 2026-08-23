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

  const qualityForMediaType = (mediaType: string): number => {
    const [type, subtype] = mediaType.split("/");
    let selectedSpecificity = -1;
    let selectedQuality = 0;

    for (const range of accept.split(",")) {
      const [rangeMediaType, ...parameters] = range.split(";");
      const [rangeType, rangeSubtype] = rangeMediaType.trim().toLowerCase().split("/");
      let specificity = -1;

      if (rangeType === "*" && rangeSubtype === "*") {
        specificity = 0;
      } else if (rangeType === type && rangeSubtype === "*") {
        specificity = 1;
      } else if (rangeType === type && rangeSubtype === subtype) {
        specificity = 2;
      }

      if (specificity > selectedSpecificity) {
        selectedSpecificity = specificity;
        selectedQuality = qualityForParameters(parameters);
      }
    }

    return selectedQuality;
  };

  return qualityForMediaType("text/markdown") > qualityForMediaType("text/html");
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

  if (!assetResponse.ok && assetResponse.status !== 304) {
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
    const pageRequest = isPageRequest(request);

    if (pageRequest && acceptsMarkdown(request.headers.get("Accept"))) {
      const response = await markdownResponse(request, env);
      if (response) {
        return response;
      }
    }

    const response = await env.ASSETS.fetch(request);
    if (!pageRequest) {
      return response;
    }

    const headers = new Headers(response.headers);
    headers.set("Vary", addAcceptToVary(headers.get("Vary")));

    return new Response(request.method === "HEAD" ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
};

export default worker;
