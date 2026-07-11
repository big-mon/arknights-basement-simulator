import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App, assignmentsForFacilitySlots } from "./App";
import { FacilityPlanCard } from "./components/FacilityPlanCard";
import { createDefaultState, operators } from "./data/defaults";
import { productLabels } from "./i18n";
import { localizeText } from "./lib/localization";
import { maxImportJsonBytes } from "./lib/storage";
import type { Assignment, FacilityPlan } from "./types";

const amiya = operators.find((operator) => operator.id === "char_002_amiya")!;
const amiyaName = localizeText(amiya.name, "ja");
const threeStarOperator = operators.find((operator) => operator.rarity === 3)!;
const lowRarityOperator = operators.find((operator) => operator.rarity <= 2)!;
const phonor = operators.find((operator) => operator.id === "char_4136_phonor")!;
const silverashAlter = operators.find((operator) => operator.id === "char_1045_svash2")!;
const makiri = operators.find((operator) => operator.id === "char_4199_makiri")!;
const haruka = operators.find((operator) => operator.id === "char_4202_haruka")!;
const mantra = operators.find((operator) => operator.id === "char_4204_mantra")!;
const bellone = operators.find((operator) => operator.id === "char_4037_demetr")!;
const snegurochka = operators.find((operator) => operator.id === "char_4208_wintim")!;
const suzuran = operators.find((operator) => operator.id === "char_358_lisa")!;
const bibeak = operators.find((operator) => operator.id === "char_252_bibeak")!;
const rhodesCovert = operators.find((operator) => operator.id === "char_4215_buddy")!;
const varkalis = operators.find((operator) => operator.id === "char_4166_varkis")!;
const nyamu = operators.find((operator) => operator.id === "char_4185_amoris")!;
const zinogreCatapult = operators.find((operator) => operator.id === "char_1049_catap2")!;
const cairn = operators.find((operator) => operator.id === "char_4214_cairn")!;
const crackbone = operators.find((operator) => operator.id === "char_4225_tanya")!;
const kichisei = operators.find((operator) => operator.id === "char_4203_kichi")!;
const snowHunter = operators.find((operator) => operator.id === "char_4211_snhunt")!;
const veen = operators.find((operator) => operator.id === "char_4226_veen")!;
const reprise = operators.find((operator) => operator.id === "char_4031_liesel")!;
const akkord = operators.find((operator) => operator.id === "char_4051_akkord")!;
const taraxacum = operators.find((operator) => operator.id === "char_4222_taraxa")!;
const radian = operators.find((operator) => operator.id === "char_4195_radian")!;
const xiangPerfumer = operators.find((operator) => operator.id === "char_1022_flwr2")!;
const wang = operators.find((operator) => operator.id === "char_2027_wang")!;
const wisadel = operators.find((operator) => operator.id === "char_1035_wisdel")!;
const levelLockedOperator = operators.find((operator) => operator.skills.some((skill) => skill.unlockLevel > 1))!;
const missingEnglishSkillOperator = operators.find((operator) =>
  operator.skills.some((skill) => !skill.name.en || skill.effects.some((effect) => !effect.description.en))
)!;
const missingEnglishSkillOperatorName = localizeText(missingEnglishSkillOperator.name, "en");

function operatorNameJa(operator: (typeof operators)[number]) {
  return localizeText(operator.name, "ja");
}

describe("App", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("sets roster ownership and keeps it after remount", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    const amiyaCard = screen.getByText(amiyaName).closest("article")!;
    const checkbox = within(amiyaCard).getByRole("checkbox", { name: amiyaName }) as HTMLInputElement;

    await user.click(checkbox);
    expect(checkbox).toBeChecked();

    unmount();
    render(<App />);
    expect(within(screen.getByText(amiyaName).closest("article")!).getByRole("checkbox", { name: amiyaName })).toBeChecked();
  });

  it("keeps operator details compact until explicitly expanded", async () => {
    const user = userEvent.setup();
    render(<App />);
    const amiyaCard = screen.getByText(amiyaName).closest("article")!;
    const details = within(amiyaCard).getByText("育成状況・詳細").closest("details")!;

    expect(details).not.toHaveAttribute("open");
    await user.click(within(amiyaCard).getByText("育成状況・詳細"));
    expect(details).toHaveAttribute("open");
  });

  it("selects and clears all operators currently shown by the filters", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByPlaceholderText("名前で検索"), amiyaName);
    await user.click(screen.getByRole("button", { name: "表示中をすべて選択" }));
    expect(within(screen.getByText(amiyaName).closest("article")!).getByRole("checkbox", { name: amiyaName })).toBeChecked();
    expect(screen.getByRole("button", { name: "選択した1人で配置を計算" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "表示中をすべて解除" }));
    expect(within(screen.getByText(amiyaName).closest("article")!).getByRole("checkbox", { name: amiyaName })).not.toBeChecked();
  });

  it("can limit the roster to selected operators", async () => {
    const user = userEvent.setup();
    render(<App />);
    const amiyaCheckbox = within(screen.getByText(amiyaName).closest("article")!).getByRole("checkbox", { name: amiyaName });

    await user.click(amiyaCheckbox);
    await user.click(screen.getByRole("checkbox", { name: "選択済みのみ" }));

    expect(screen.getByText(amiyaName)).toBeInTheDocument();
    expect(screen.queryByText(operatorNameJa(threeStarOperator))).not.toBeInTheDocument();
  });

  it("starts with no owned operators selected", () => {
    render(<App />);

    expect(screen.getByText(`0/${operators.length}`)).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox").every((checkbox) => !(checkbox as HTMLInputElement).checked)).toBe(true);
  });

  it("rejects oversized imported JSON files before reading them", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await user.upload(input, new File([new Uint8Array(maxImportJsonBytes + 1)], "large.json", { type: "application/json" }));

    expect(screen.getByText(/128KiB/)).toBeInTheDocument();
  });

  it("links to the OSS repository from the footer", () => {
    render(<App />);

    expect(screen.getByRole("link", { name: /big-mon\/arknights-basement-simulator/ })).toHaveAttribute(
      "href",
      "https://github.com/big-mon/arknights-basement-simulator"
    );
    expect(screen.getByRole("link", { name: /@BIG_MON/ })).toHaveAttribute("href", "https://x.com/BIG_MON");
    expect(screen.getByText(/非公式のファンメイドツール/)).toBeInTheDocument();
    expect(screen.getByText(/公式から削除要請/)).toBeInTheDocument();
  });

  it("shows locally hosted operator face icons", () => {
    render(<App />);

    expect(screen.getByRole("img", { name: `${amiyaName} icon` })).toHaveAttribute(
      "src",
      "/operator-avatars/char_002_amiya.png"
    );
  });

  it("explains the roster data scope", () => {
    render(<App />);

    expect(screen.getByText(/表示対象は、現在対応している基地スキルを持つオペレーターです/)).toBeInTheDocument();
  });

  it("shows calculation assumptions and excluded effect notes at the page bottom", () => {
    render(<App />);

    const notesSection = screen.getByRole("heading", { name: "計算前提と未換算効果" }).closest("section")!;
    expect(notesSection).toBeInTheDocument();
    expect(within(notesSection).getByText(/施設レベルは上限として扱います/)).toBeInTheDocument();
    expect(within(notesSection).getByText(/高価値オーダー確率/)).toBeInTheDocument();
    expect(within(notesSection).getByText(/グレイディーア/)).toBeInTheDocument();
  });

  it("supplements missing Japanese operator names", () => {
    expect(operators.filter((operator) => !operator.name.ja)).toHaveLength(0);
    expect(operators.filter((operator) => !operator.name.en)).toHaveLength(0);
    expect(makiri.name.ja).toBe("マツキリ");
    expect(haruka.name.ja).toBe("ハルカ");
    expect(mantra.name.ja).toBe("マントラ");
    expect(mantra.name.en).toBe("Mantra");
    expect(bellone.name.ja).toBe("ベッローネ");
    expect(snegurochka.name.ja).toBe("スネグーラチカ");
    expect(rhodesCovert.name.ja).toBe("ロドスアイランド隠密隊");
    expect(varkalis.name.ja).toBe("ヴァルカリス");
    expect(varkalis.name.en).toBe("Varkáris");
    expect(nyamu.name.ja).toBe("祐天寺にゃむ");
    expect(zinogreCatapult.name.ja).toBe("ジンオウSカタパルト");
    expect(cairn.name.ja).toBe("ケルン");
    expect(crackbone.name.ja).toBe("クラックボーン");
    expect(kichisei.name.ja).toBe("キチセイ");
    expect(snowHunter.name.ja).toBe("スノーハンター");
    expect(veen.name.ja).toBe("ヴィイ");
    expect(reprise.name.ja).toBe("リプレーザ");
    expect(akkord.name.ja).toBe("アコルト");
    expect(taraxacum.name.ja).toBe("タラクサクム");
    expect(radian.name.ja).toBe("レイディアン");
    expect(radian.name.en).toBe("Raidian");
    expect(xiangPerfumer.name.ja).toBe("萃香パフューマー");
    expect(wang.name.ja).toBe("ウァン");
  });

  it("marks unverified selected-language skill text without excluding operators", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.selectOptions(screen.getByRole("combobox", { name: /言語/ }), "en");
    await user.type(screen.getByPlaceholderText("Search by name"), missingEnglishSkillOperator.id);

    const operatorCard = screen.getByText(missingEnglishSkillOperatorName).closest("article")!;
    const checkbox = within(operatorCard).getByRole("checkbox", { name: missingEnglishSkillOperatorName }) as HTMLInputElement;

    expect(within(operatorCard).getAllByLabelText(/Base-skill translation is unverified/).length).toBeGreaterThan(0);

    await user.click(checkbox);

    expect(checkbox).toBeChecked();
  });

  it("switches the app language from the top toolbar", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByRole("heading", { name: "基地ローテーションシミュレーター" })).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: /言語/ }), "en");

    expect(screen.getByRole("heading", { name: "Base Rotation Simulator" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Owned/ })).toBeInTheDocument();
    expect(screen.getByText(localizeText(amiya.name, "en"))).toBeInTheDocument();
    expect(screen.getByText(localizeText(amiya.skills[0].name, "en"))).toBeInTheDocument();
    expect(screen.getAllByText(localizeText(amiya.skills[0].effects[0].description, "en"), { exact: false }).length).toBeGreaterThan(0);

    await user.selectOptions(screen.getByRole("combobox", { name: /Language/ }), "zh");

    expect(screen.getByRole("heading", { name: "基建轮班模拟器" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /持有/ })).toBeInTheDocument();
    expect(screen.getByText(localizeText(amiya.name, "zh"))).toBeInTheDocument();
    expect(screen.getByText(localizeText(amiya.skills[0].name, "zh"))).toBeInTheDocument();
    expect(screen.getAllByText(localizeText(amiya.skills[0].effects[0].description, "zh"), { exact: false }).length).toBeGreaterThan(0);
  });

  it("toggles roster ownership from the operator card without hijacking controls", async () => {
    const user = userEvent.setup();
    render(<App />);
    const amiyaCard = screen.getByText(amiyaName).closest("article")!;
    const checkbox = within(amiyaCard).getByRole("checkbox", { name: amiyaName }) as HTMLInputElement;
    const defaultState = createDefaultState();
    const professionTotal = operators.filter((operator) => operator.profession === amiya.profession).length;
    const rarityTotal = operators.filter((operator) => operator.profession === amiya.profession && operator.rarity === amiya.rarity).length;
    const initialProfessionOwned = operators.filter(
      (operator) => operator.profession === amiya.profession && defaultState.roster[operator.id]?.owned
    ).length;
    const initialRarityOwned = operators.filter(
      (operator) => operator.profession === amiya.profession && operator.rarity === amiya.rarity && defaultState.roster[operator.id]?.owned
    ).length;
    const expectedOwnedDelta = checkbox.checked ? -1 : 1;

    await user.click(amiyaCard);
    expect(checkbox).toBeChecked();
    const professionSection = screen.getByRole("heading", { name: amiya.profession }).closest("section")!;
    const raritySection = within(professionSection).getByRole("heading", { name: `★${amiya.rarity}` }).closest("section")!;
    expect(within(professionSection).getByText(`${initialProfessionOwned + expectedOwnedDelta} / ${professionTotal}名`)).toBeInTheDocument();
    expect(within(raritySection).getByText(`${initialRarityOwned + expectedOwnedDelta} / ${rarityTotal}名`)).toBeInTheDocument();

    await user.selectOptions(within(amiyaCard).getByRole("combobox"), "2");
    expect(checkbox).toBeChecked();

    await user.click(amiyaCard);
    expect(checkbox).not.toBeChecked();
    expect(within(professionSection).getByText(`${initialProfessionOwned} / ${professionTotal}名`)).toBeInTheDocument();
    expect(within(raritySection).getByText(`${initialRarityOwned} / ${rarityTotal}名`)).toBeInTheDocument();
  });

  it("groups owned roster by profession and rarity", () => {
    render(<App />);

    const vanguardSection = screen.getByRole("heading", { name: "先鋒" }).closest("section")!;

    expect(vanguardSection).toBeInTheDocument();
    expect(within(vanguardSection).getByRole("heading", { name: "★6" })).toBeInTheDocument();
    expect(within(vanguardSection).getByRole("heading", { name: "★5" })).toBeInTheDocument();
  });

  it("uses game-facing rarity labels from imported data", () => {
    expect(phonor.rarity).toBe(1);
    expect(amiya.rarity).toBe(5);

    render(<App />);

    const phonorCard = screen.getByText("PhonoR-0").closest("article")!;
    const amiyaCard = screen.getByText(amiyaName).closest("article")!;

    expect(within(phonorCard).getByText(/★1/)).toBeInTheDocument();
    expect(within(amiyaCard).getByText(/★5/)).toBeInTheDocument();
  });

  it("includes special playable operators from CN game data", () => {
    expect(silverashAlter.rarity).toBe(6);
    expect(silverashAlter.name.zh).toBeTruthy();
    expect(silverashAlter.name.ja).toBe("凛御シルバーアッシュ");
    expect(silverashAlter.skills.length).toBeGreaterThan(0);
  });

  it("includes reception-only operators in the roster", async () => {
    const user = userEvent.setup();
    expect(makiri.rarity).toBe(5);
    expect(makiri.name.ja).toBe("マツキリ");
    expect(makiri.skills.some((skill) => skill.effects.some((effect) => effect.facility === "reception"))).toBe(true);

    render(<App />);
    await user.type(screen.getByPlaceholderText("名前で検索"), makiri.id);

    const makiriCard = screen.getByText(localizeText(makiri.name, "ja")).closest("article")!;
    expect(within(makiriCard).getByText(/★5/)).toBeInTheDocument();
    expect(within(makiriCard).getAllByText(/応接室/).length).toBeGreaterThan(0);
  });

  it("includes skillless operators referenced by another operator's base skill", async () => {
    const user = userEvent.setup();
    expect(suzuran.name.ja).toBe("スズラン");
    expect(suzuran.skills).toHaveLength(0);

    render(<App />);
    await user.type(screen.getByPlaceholderText("名前で検索"), suzuran.id);

    const suzuranCard = screen.getByText("スズラン").closest("article")!;
    expect(suzuranCard).toBeInTheDocument();
    expect(within(suzuranCard).queryByText(/基地スキル/)).not.toBeInTheDocument();
  });

  it("only shows level choices when a base skill has a level requirement and defaults to the higher level", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByPlaceholderText("名前で検索"), levelLockedOperator.id);
    const levelLockedCard = screen.getByText(operatorNameJa(levelLockedOperator)).closest("article")!;
    const levelSelect = within(levelLockedCard).getByRole("combobox", { name: "レベル" });
    const highestUnlockLevel = Math.max(...levelLockedOperator.skills.map((skill) => skill.unlockLevel));

    expect(levelSelect).toHaveValue(String(highestUnlockLevel));

    await user.clear(screen.getByPlaceholderText("名前で検索"));
    await user.type(screen.getByPlaceholderText("名前で検索"), amiya.id);
    const amiyaCard = screen.getByText(amiyaName).closest("article")!;
    expect(within(amiyaCard).queryByRole("combobox", { name: "レベル" })).not.toBeInTheDocument();
  });

  it("marks unsupported optimization-only effects on operator cards", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByPlaceholderText(/名前で検索/), bibeak.id);

    const bibeakCard = screen.getByText(localizeText(bibeak.name, "ja")).closest("article")!;
    expect(within(bibeakCard).getAllByText("最適化計算対象外").length).toBeGreaterThan(0);
  });

  it("hides calculation-only split effects from operator skill descriptions", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByPlaceholderText("名前で検索"), wisadel.id);
    const wisadelCard = screen.getByText(operatorNameJa(wisadel)).closest("article")!;

    expect(within(wisadelCard).getAllByText(/イネスが応接室に配置されているとき/)).toHaveLength(2);
    expect(within(wisadelCard).queryByText(/if Ines is assigned to the Reception Room/)).not.toBeInTheDocument();
  });

  it("filters the owned roster with profession and rarity radio options", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.queryByRole("combobox", { name: /全職業/ })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "全職業" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "全☆" })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "術師" }));

    expect(screen.getByRole("heading", { name: "術師" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "先鋒" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "★6" }));

    const casterSection = screen.getByRole("heading", { name: "術師" }).closest("section")!;
    expect(within(casterSection).getByRole("heading", { name: "★6" })).toBeInTheDocument();
    expect(within(casterSection).queryByRole("heading", { name: "★5" })).not.toBeInTheDocument();
  });

  it("collapses profession and rarity groups in the owned roster", async () => {
    const user = userEvent.setup();
    const profession = "先鋒";
    const professionOperators = operators.filter((operator) => operator.profession === profession);
    const highestRarity = Math.max(...professionOperators.map((operator) => operator.rarity));
    const firstOperator = professionOperators.find((operator) => operator.rarity === highestRarity)!;
    render(<App />);

    const professionSection = screen.getByRole("heading", { name: profession }).closest("section")!;
    const professionToggle = within(professionSection).getByRole("button", { name: profession });

    expect(within(professionSection).getByText(operatorNameJa(firstOperator))).toBeInTheDocument();
    expect(professionToggle).toHaveAttribute("aria-expanded", "true");

    await user.click(professionToggle);

    expect(professionToggle).toHaveAttribute("aria-expanded", "false");
    expect(within(professionSection).queryByText(operatorNameJa(firstOperator))).not.toBeInTheDocument();

    await user.click(professionToggle);

    const rarityToggle = within(professionSection).getByRole("button", { name: `★${highestRarity}` });
    expect(rarityToggle).toHaveAttribute("aria-expanded", "true");

    await user.click(rarityToggle);

    expect(rarityToggle).toHaveAttribute("aria-expanded", "false");
    expect(within(professionSection).queryByText(operatorNameJa(firstOperator))).not.toBeInTheDocument();
  });

  it("shows base skill names, targets, and unlock state on operator cards", async () => {
    const user = userEvent.setup();
    render(<App />);
    const amiyaCard = screen.getByText(amiyaName).closest("article")!;
    const skillList = within(amiyaCard).getByRole("list", { name: `${amiyaName}の基地スキル` });
    const [firstSkill, secondSkill] = amiya.skills;

    expect(within(skillList).getByText(localizeText(firstSkill.name, "ja"))).toBeInTheDocument();
    expect(within(skillList).getByText(localizeText(secondSkill.name, "ja"))).toBeInTheDocument();
    expect(within(skillList).getAllByText(/制御中枢/).length).toBeGreaterThan(0);
    expect(within(skillList).getByText("昇進2 Lv.1で解放")).toBeInTheDocument();

    await user.selectOptions(within(amiyaCard).getByRole("combobox"), "2");

    expect(within(skillList).getAllByText("解放済み")).toHaveLength(2);
  });

  it("limits elite phase options by operator rarity", () => {
    render(<App />);

    const threeStarCard = screen.getByText(operatorNameJa(threeStarOperator)).closest("article")!;
    const threeStarEliteSelect = within(threeStarCard).getByRole("combobox") as HTMLSelectElement;
    expect(Array.from(threeStarEliteSelect.options).map((option) => option.value)).toEqual(["0", "1"]);

    const lowRarityCard = screen.getByText(operatorNameJa(lowRarityOperator)).closest("article")!;
    const lowRarityEliteSelect = within(lowRarityCard).getByRole("combobox") as HTMLSelectElement;
    expect(Array.from(lowRarityEliteSelect.options).map((option) => option.value)).toEqual(["0"]);
  });

  it("shows assignment suggestions after switching to recommendation tab", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /提案/ }));

    expect(screen.getByRole("heading", { name: "推奨配置とローテーション" })).toBeInTheDocument();
    expect(screen.getAllByText("製造所 A").length).toBeGreaterThan(0);
    const rotationSuggestions = screen.getByLabelText("ローテーション別提案");
    expect(rotationSuggestions).toBeInTheDocument();
    expect(screen.getByText("日次価値")).toBeInTheDocument();
    expect(screen.getByText("総合スコア")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /2回.*選択中/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /3回/ })).toBeDisabled();
    expect(screen.getByText("生産物の優先度")).toBeInTheDocument();
    expect(screen.getByText("選んだ方針に合わせて、対応する基地スキルと施設配置を強く評価します。")).toBeInTheDocument();
    expect(screen.queryByText("純金・作戦記録・龍門幣を近い重みで評価")).not.toBeInTheDocument();
    expect(screen.queryByText("純金向けの製造所スキルを高く評価")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /バランス/ })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /純金優先/ }));
    expect(screen.getByRole("radio", { name: /純金優先/ })).toBeChecked();
    expect(screen.getByText("1回目ローテーション")).toBeInTheDocument();
    expect(screen.getByText("2回目ローテーション")).toBeInTheDocument();
    expect(screen.queryByText("第3ローテーション")).not.toBeInTheDocument();
    expect(within(rotationSuggestions).getAllByText("貿易所 A")[0].closest("article")).toHaveClass("plan-card-trading");
    expect(within(rotationSuggestions).getAllByText("製造所 A")[0].closest("article")).toHaveClass("plan-card-factory");
    expect(within(rotationSuggestions).getAllByText("発電所 A")[0].closest("article")).toHaveClass("plan-card-power");
    expect(within(rotationSuggestions).queryByText("宿舎")).not.toBeInTheDocument();
    expect(screen.queryByText("3枠")).not.toBeInTheDocument();
    expect(screen.queryByText("生産")).not.toBeInTheDocument();
    expect(within(rotationSuggestions).queryByText(/貿易所 \/ 龍門幣/)).not.toBeInTheDocument();
  });

  it("shows target products on trading and factory recommendation cards", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);

    const planTab = container.querySelectorAll(".tabs .tab")[1] as HTMLElement;
    await user.click(planTab);

    const tradingCard = container.querySelector(".plan-card-trading") as HTMLElement;
    const factoryCard = container.querySelector(".plan-card-factory") as HTMLElement;
    const powerCard = container.querySelector(".plan-card-power") as HTMLElement;

    expect(within(tradingCard).getByText(productLabels.ja.lmd)).toBeInTheDocument();
    expect(within(factoryCard).getByText(productLabels.ja.gold)).toBeInTheDocument();
    expect(within(powerCard).queryByText(productLabels.ja.power)).not.toBeInTheDocument();
  });

  it("shows facility-level expected efficiency in active recommendation cards", () => {
    const assignment: Assignment = {
      facilityId: "reception-1",
      operatorId: amiya.id,
      skillId: "candidate",
      score: 0.23,
      efficiency: 0.23,
      fatigueHours: 24,
      recoveryHours: 8,
      reason: "candidate"
    };
    const facilityPlan: FacilityPlan = {
      facility: { id: "reception-1", type: "reception", name: "Reception", slotCount: 2, product: "clue" },
      assignments: [assignment],
      expectedEfficiency: 0.48,
      score: 0.48,
      alternatives: []
    };

    render(
      <FacilityPlanCard
        facilityPlan={facilityPlan}
        assignments={facilityPlan.assignments}
        language="ja"
        operatorNameById={() => amiyaName}
      />
    );

    expect(screen.getByText("+48%")).toBeInTheDocument();
  });

  it("shows facility-level expected efficiency in alternative recommendation cards", () => {
    const assignment: Assignment = {
      facilityId: "reception-1",
      operatorId: amiya.id,
      skillId: "candidate",
      score: 0.23,
      efficiency: 0.23,
      fatigueHours: 24,
      recoveryHours: 8,
      reason: "candidate"
    };
    const facilityPlan: FacilityPlan = {
      facility: { id: "reception-1", type: "reception", name: "Reception", slotCount: 2, product: "clue" },
      assignments: [],
      expectedEfficiency: 0,
      alternativeExpectedEfficiency: 0.48,
      score: 0.48,
      alternatives: [assignment]
    };

    render(
      <FacilityPlanCard
        facilityPlan={facilityPlan}
        assignments={assignmentsForFacilitySlots(facilityPlan.alternatives, facilityPlan.facility.slotCount)}
        expectedEfficiency={facilityPlan.alternativeExpectedEfficiency}
        language="ja"
        operatorNameById={() => amiyaName}
      />
    );

    expect(screen.getByText("+48%")).toBeInTheDocument();
  });

  it("keeps non-slot prerequisites from hiding alternative room occupants", () => {
    const assignments: Assignment[] = [
      {
        facilityId: "trading-1",
        operatorId: "operator-a",
        skillId: "candidate-a",
        score: 30,
        efficiency: 0.3,
        fatigueHours: 12,
        recoveryHours: 8,
        reason: "candidate-a"
      },
      {
        facilityId: "base",
        operatorId: "operator-prerequisite",
        skillId: "base-skillless-prerequisite",
        score: 0,
        efficiency: 0,
        fatigueHours: 12,
        recoveryHours: 8,
        baseSkilllessPrerequisiteFor: "operator-a",
        doesNotConsumeFacilitySlot: true,
        reason: "Base-wide skillless prerequisite"
      },
      {
        facilityId: "trading-1",
        operatorId: "operator-b",
        skillId: "candidate-b",
        score: 25,
        efficiency: 0.25,
        fatigueHours: 12,
        recoveryHours: 8,
        reason: "candidate-b"
      },
      {
        facilityId: "trading-1",
        operatorId: "operator-c",
        skillId: "candidate-c",
        score: 20,
        efficiency: 0.2,
        fatigueHours: 12,
        recoveryHours: 8,
        reason: "candidate-c"
      }
    ];

    expect(assignmentsForFacilitySlots(assignments, 3).map((assignment) => assignment.operatorId)).toEqual([
      "operator-a",
      "operator-prerequisite",
      "operator-b",
      "operator-c"
    ]);
  });

  it("switches layout between 243 and 153 presets from the top controls", async () => {
    const user = userEvent.setup();
    render(<App />);

    const summary = screen.getByLabelText("現在の概要");
    expect(within(summary).queryByText("日次価値")).not.toBeInTheDocument();
    expect(within(summary).queryByText("総合スコア")).not.toBeInTheDocument();
    const layoutSelect = screen.getByRole("combobox", { name: /基地構成/ }) as HTMLSelectElement;
    expect(layoutSelect).toHaveValue("243");
    expect(screen.getByRole("option", { name: /243型.*貿易所2・製造所4・発電所3/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /提案/ }));
    expect(screen.getAllByText("貿易所 B").length).toBeGreaterThan(0);
    expect(screen.getAllByText("製造所 D").length).toBeGreaterThan(0);

    await user.selectOptions(layoutSelect, "153");

    expect(layoutSelect).toHaveValue("153");
    expect(screen.queryByText("貿易所 B")).not.toBeInTheDocument();
    expect(screen.getAllByText("製造所 E").length).toBeGreaterThan(0);
  });

  it("normalizes an invalid saved layout back to 243", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "arknights-basement-state-v1",
      JSON.stringify({
        layout: "unknown",
        rotationCount: 3,
        roster: {},
        facilities: [],
        preference: { gold: 0.35, battleRecord: 0.35, lmd: 0.3 }
      })
    );

    render(<App />);
    await user.click(screen.getByRole("button", { name: /提案/ }));

    expect(screen.getByRole("combobox", { name: /基地構成/ })).toHaveValue("243");
    expect(screen.getByRole("button", { name: /2回.*選択中/ })).toHaveAttribute("aria-pressed", "true");
  });
});
