import type { LanguageCode, LocalizedText } from "../types";

const fallbackLanguageOrder: LanguageCode[] = ["ja", "zh", "en"];

export function localizeText(value: LocalizedText | string | undefined, language: LanguageCode): string {
  if (typeof value === "string") {
    return value;
  }
  if (!value) {
    return "";
  }

  return value[language] ?? fallbackLanguageOrder.map((fallback) => value[fallback]).find(Boolean) ?? "";
}

export function localizedTextValues(value: LocalizedText | string | undefined): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!value) {
    return [];
  }

  return Array.from(new Set(Object.values(value).filter(Boolean)));
}

export function languageLocale(language: LanguageCode): string {
  if (language === "zh") {
    return "zh-CN";
  }
  if (language === "en") {
    return "en-US";
  }
  return "ja-JP";
}
