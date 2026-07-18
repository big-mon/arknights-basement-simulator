export function applyWikiJapaneseLocalization(skill, skillFallback, localizedName, localizedDescription) {
  if (!skill.name.ja?.trim()) {
    skill.name.ja = localizedName;
  }
  skillFallback.name = { ...(skillFallback.name ?? {}), ja: localizedName };

  for (const effect of skill.effects) {
    if (!effect.hiddenFromUi && !effect.description.ja?.trim()) {
      effect.description.ja = localizedDescription;
    }
  }
  skillFallback.description = { ...(skillFallback.description ?? {}), ja: localizedDescription };
}
