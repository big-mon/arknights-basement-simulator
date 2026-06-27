import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { operators } from "./data/defaults";

const amiya = operators.find((operator) => operator.id === "char_002_amiya")!;

describe("App", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("sets roster ownership and keeps it after remount", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    const amiyaCard = screen.getByText(amiya.name).closest("article")!;
    const checkbox = within(amiyaCard).getByRole("checkbox", { name: amiya.name });

    await user.click(checkbox);
    expect(checkbox).toBeChecked();

    unmount();
    render(<App />);
    expect(within(screen.getByText(amiya.name).closest("article")!).getByRole("checkbox", { name: amiya.name })).toBeChecked();
  });

  it("groups owned roster by profession and rarity", () => {
    render(<App />);

    const vanguardSection = screen.getByRole("heading", { name: "先鋒" }).closest("section")!;

    expect(vanguardSection).toBeInTheDocument();
    expect(within(vanguardSection).getByRole("heading", { name: "★6" })).toBeInTheDocument();
    expect(within(vanguardSection).getByRole("heading", { name: "★5" })).toBeInTheDocument();
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
