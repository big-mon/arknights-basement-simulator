import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { createDefaultState, operators } from "./data/defaults";

const amiya = operators.find((operator) => operator.id === "char_002_amiya")!;

describe("App", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("sets roster ownership and keeps it after remount", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    const amiyaCard = screen.getByText(amiya.name).closest("article")!;
    const checkbox = within(amiyaCard).getByRole("checkbox", { name: amiya.name }) as HTMLInputElement;

    await user.click(checkbox);
    expect(checkbox).toBeChecked();

    unmount();
    render(<App />);
    expect(within(screen.getByText(amiya.name).closest("article")!).getByRole("checkbox", { name: amiya.name })).toBeChecked();
  });

  it("starts with no owned operators selected", () => {
    render(<App />);

    expect(screen.getByText(`0/${operators.length}`)).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox").every((checkbox) => !(checkbox as HTMLInputElement).checked)).toBe(true);
  });

  it("switches the app language from the top toolbar", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByRole("heading", { name: "基地ローテーションシミュレーター" })).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: /言語/ }), "en");

    expect(screen.getByRole("heading", { name: "Base Rotation Simulator" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Owned/ })).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: /Language/ }), "zh");

    expect(screen.getByRole("heading", { name: "基建轮班模拟器" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /持有/ })).toBeInTheDocument();
  });

  it("toggles roster ownership from the operator card without hijacking controls", async () => {
    const user = userEvent.setup();
    render(<App />);
    const amiyaCard = screen.getByText(amiya.name).closest("article")!;
    const checkbox = within(amiyaCard).getByRole("checkbox", { name: amiya.name }) as HTMLInputElement;
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

  it("collapses profession and rarity groups in the owned roster", async () => {
    const user = userEvent.setup();
    const profession = "先鋒";
    const professionOperators = operators.filter((operator) => operator.profession === profession);
    const highestRarity = Math.max(...professionOperators.map((operator) => operator.rarity));
    const firstOperator = professionOperators.find((operator) => operator.rarity === highestRarity)!;
    render(<App />);

    const professionSection = screen.getByRole("heading", { name: profession }).closest("section")!;
    const professionToggle = within(professionSection).getByRole("button", { name: profession });

    expect(within(professionSection).getByText(firstOperator.name)).toBeInTheDocument();
    expect(professionToggle).toHaveAttribute("aria-expanded", "true");

    await user.click(professionToggle);

    expect(professionToggle).toHaveAttribute("aria-expanded", "false");
    expect(within(professionSection).queryByText(firstOperator.name)).not.toBeInTheDocument();

    await user.click(professionToggle);

    const rarityToggle = within(professionSection).getByRole("button", { name: `★${highestRarity}` });
    expect(rarityToggle).toHaveAttribute("aria-expanded", "true");

    await user.click(rarityToggle);

    expect(rarityToggle).toHaveAttribute("aria-expanded", "false");
    expect(within(professionSection).queryByText(firstOperator.name)).not.toBeInTheDocument();
  });

  it("shows base skill names, targets, and unlock state on operator cards", async () => {
    const user = userEvent.setup();
    render(<App />);
    const amiyaCard = screen.getByText(amiya.name).closest("article")!;
    const skillList = within(amiyaCard).getByRole("list", { name: `${amiya.name}の基地スキル` });
    const [firstSkill, secondSkill] = amiya.skills;

    expect(within(skillList).getByText(firstSkill.name)).toBeInTheDocument();
    expect(within(skillList).getByText(secondSkill.name)).toBeInTheDocument();
    expect(within(skillList).getAllByText(/制御中枢/).length).toBeGreaterThan(0);
    expect(within(skillList).getByText("昇進2で解放")).toBeInTheDocument();

    await user.selectOptions(within(amiyaCard).getByRole("combobox"), "2");

    expect(within(skillList).getAllByText("解放済み")).toHaveLength(2);
  });

  it("shows assignment suggestions after switching to recommendation tab", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /提案/ }));

    expect(screen.getByRole("heading", { name: "推奨配置とローテーション" })).toBeInTheDocument();
    expect(screen.getAllByText("製造所 A").length).toBeGreaterThan(0);
    const rotationSuggestions = screen.getByLabelText("ローテーション別提案");
    expect(rotationSuggestions).toBeInTheDocument();
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

  it("switches layout between 243 and 153 presets from the recommendation tab", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.queryByRole("button", { name: /基地/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /提案/ }));
    expect(screen.getByRole("button", { name: /243型/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByText("貿易所 B").length).toBeGreaterThan(0);
    expect(screen.getAllByText("製造所 D").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: /153型/ }));

    expect(screen.getByRole("button", { name: /153型/ })).toHaveAttribute("aria-pressed", "true");
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

    expect(screen.getByRole("button", { name: /243型/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("構成").nextSibling).toHaveTextContent("243型");
  });
});
