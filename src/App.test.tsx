import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("sets roster ownership and keeps it after remount", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    const amiyaCard = screen.getByText("アーミヤ").closest("article")!;
    const checkbox = within(amiyaCard).getByRole("checkbox", { name: /アーミヤ/ });

    await user.click(checkbox);
    expect(checkbox).toBeChecked();

    unmount();
    render(<App />);
    expect(within(screen.getByText("アーミヤ").closest("article")!).getByRole("checkbox", { name: /アーミヤ/ })).toBeChecked();
  });

  it("shows assignment suggestions after switching to recommendation tab", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /提案/ }));

    expect(screen.getByRole("heading", { name: "推奨配置とローテーション" })).toBeInTheDocument();
    expect(screen.getByText("製造所 A")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "ローテーション" })).toBeInTheDocument();
  });

  it("switches base layout between 243 and 153 presets", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /基地/ }));
    expect(screen.getByText("貿易所 B")).toBeInTheDocument();
    expect(screen.getByText("製造所 D")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /153型/ }));

    expect(screen.queryByText("貿易所 B")).not.toBeInTheDocument();
    expect(screen.getByText("製造所 E")).toBeInTheDocument();
  });
});
