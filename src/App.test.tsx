import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { createDefaultState, operators } from "./data/defaults";
import { productLabels } from "./i18n";
import { localizeText } from "./lib/localization";

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
const missingEnglishNameOperator = operators.find((operator) => !operator.name.en)!;
const missingEnglishFallbackName = localizeText(missingEnglishNameOperator.name, "en");

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

  it("starts with no owned operators selected", () => {
    render(<App />);

    expect(screen.getByText(`0/${operators.length}`)).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox").every((checkbox) => !(checkbox as HTMLInputElement).checked)).toBe(true);
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
    expect(makiri.name.ja).toBe("マツキリ");
    expect(haruka.name.ja).toBe("ハルカ");
    expect(mantra.name.ja).toBe("マントラ");
    expect(mantra.name.en).toBe("Mantra");
    expect(bellone.name.ja).toBe("ベッローネ");
    expect(snegurochka.name.ja).toBe("スネグーラチカ");
    expect(rhodesCovert.name.ja).toBe("ロドスアイランド隠密隊");
    expect(varkalis.name.ja).toBe("ヴァルカリス");
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
    expect(xiangPerfumer.name.ja).toBe("萃香パフューマー");
    expect(wang.name.ja).toBe("ウァン");
  });

  it("marks missing selected-language names without excluding operators", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.selectOptions(screen.getByRole("combobox", { name: /言語/ }), "en");
    await user.type(screen.getByPlaceholderText("Search by name"), missingEnglishNameOperator.id);

    const operatorCard = screen.getByText(missingEnglishFallbackName).closest("article")!;
    const checkbox = within(operatorCard).getByRole("checkbox", { name: missingEnglishFallbackName }) as HTMLInputElement;

    expect(within(operatorCard).getByLabelText("Name missing for selected language")).toBeInTheDocument();

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
    expect(within(suzuranCard).getByText(/基地スキル 0\/0/)).toBeInTheDocument();
  });

  it("marks unsupported optimization-only effects on operator cards", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByPlaceholderText(/名前で検索/), bibeak.id);

    const bibeakCard = screen.getByText(localizeText(bibeak.name, "ja")).closest("article")!;
    expect(within(bibeakCard).getAllByText("最適化計算対象外").length).toBeGreaterThan(0);
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
    expect(within(skillList).getByText("昇進2で解放")).toBeInTheDocument();

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
