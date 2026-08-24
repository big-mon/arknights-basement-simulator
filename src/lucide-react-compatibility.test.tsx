import { render, screen } from "@testing-library/react";
import {
  Activity,
  Archive,
  AtSign,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Code,
  Download,
  Languages,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Upload,
  Users,
  type LucideIcon
} from "lucide-react";
import lucidePackage from "lucide-react/package.json";
import packageManifest from "../package.json";
import { describe, expect, it } from "vitest";

const usedIcons: Record<string, LucideIcon> = {
  Activity,
  Archive,
  AtSign,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Code,
  Download,
  Languages,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Upload,
  Users
};

describe("lucide-react compatibility", () => {
  it("resolves every icon used by the app on the 1.x line", () => {
    expect(packageManifest.dependencies["lucide-react"]).toMatch(/^\^1\./);
    expect(lucidePackage.version).toMatch(/^1\./);
    expect(Object.values(usedIcons).every(Boolean)).toBe(true);
  });

  it("preserves representative icon size and decorative ARIA behavior", () => {
    render(
      <button type="button" aria-label="エクスポート">
        <Download size={18} />
      </button>
    );

    const button = screen.getByRole("button", { name: "エクスポート" });
    const icon = button.querySelector("svg");

    expect(icon).toHaveAttribute("width", "18");
    expect(icon).toHaveAttribute("height", "18");
    expect(icon).toHaveAttribute("aria-hidden", "true");
  });
});
