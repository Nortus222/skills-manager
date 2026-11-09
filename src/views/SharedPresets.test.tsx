// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedPresets } from "./SharedPresets";
import { SharedPresetsProvider } from "../context/SharedPresetsContext";

const mocks = vi.hoisted(() => ({
  getFollowedPresets: vi.fn(), previewFollowedPreset: vi.fn(), applyFollowedPreset: vi.fn(),
  unfollowPreset: vi.fn(), exportPresetRecipe: vi.fn(), writeText: vi.fn(),
  refreshPresets: vi.fn(), refreshManagedSkills: vi.fn(),
  info: vi.fn(), success: vi.fn(), error: vi.fn(),
}));
vi.mock("../lib/tauri", () => mocks);
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: mocks.writeText }));
vi.mock("react-i18next", () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock("sonner", () => ({ toast: { info: mocks.info, success: mocks.success, error: mocks.error } }));
vi.mock("../context/AppContext", () => ({ useApp: () => ({
  loading: false, presets: [{ id: "local", name: "Local preset" }],
  refreshPresets: mocks.refreshPresets, refreshManagedSkills: mocks.refreshManagedSkills,
}) }));

const url = "https://github.com/publisher/recipes/blob/main/team.json";
const followed = { preset_id: "team", name: "Team", source_url: url, revision: "old" };
const preview = {
  source_url: url, revision: "new", preset_id: null,
  recipe: { name: "Team", description: "Team recipe", skills: [{ name: "testing", install_ref: "owner/repo/testing" }] },
  additions: ["testing"], removals: ["old-skill"], conflicts: [],
};
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.getFollowedPresets.mockResolvedValue([]);
  mocks.previewFollowedPreset.mockResolvedValue(preview);
  mocks.applyFollowedPreset.mockResolvedValue({ ...followed, revision: "new" });
  mocks.unfollowPreset.mockResolvedValue(undefined);
  mocks.exportPresetRecipe.mockResolvedValue(preview.recipe);
  mocks.writeText.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function NavigationControl() {
  const navigate = useNavigate();
  return <button onClick={() => navigate("/elsewhere")}>navigate</button>;
}
async function render(strict = false) {
  const tree = <MemoryRouter><SharedPresetsProvider><SharedPresets /><NavigationControl /></SharedPresetsProvider></MemoryRouter>;
  await act(async () => root.render(strict ? <StrictMode>{tree}</StrictMode> : tree));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((button) => button.textContent === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
async function enterUrl() {
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, url);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Shared presets", () => {
  it("previews additions and membership removals, then applies only the reviewed revision", async () => {
    await render();
    await enterUrl();
    await click("sharedPresets.preview");
    expect(container.textContent).toContain("testing");
    expect(container.textContent).toContain("old-skill");
    expect(container.textContent).toContain("sharedPresets.removalHint");
    expect(mocks.applyFollowedPreset).not.toHaveBeenCalled();
    await click("sharedPresets.apply");
    expect(mocks.applyFollowedPreset).toHaveBeenCalledExactlyOnceWith(url, "new");
    expect(mocks.refreshPresets).toHaveBeenCalledOnce();
    expect(mocks.refreshManagedSkills).toHaveBeenCalledOnce();
  });

  it("blocks apply when an existing skill has a different source", async () => {
    mocks.previewFollowedPreset.mockResolvedValue({ ...preview, conflicts: ["testing"] });
    await render();
    await enterUrl();
    await click("sharedPresets.preview");
    const apply = [...container.querySelectorAll("button")].find((button) => button.textContent === "sharedPresets.apply")!;
    expect(apply.disabled).toBe(true);
    expect(container.textContent).toContain("sharedPresets.conflicts");
    expect(mocks.applyFollowedPreset).not.toHaveBeenCalled();
  });

  it("shows structured failures and retains review for a failed apply", async () => {
    mocks.applyFollowedPreset.mockRejectedValue({ kind: "invalid_input", message: "Recipe changed; preview again" });
    await render();
    await enterUrl();
    await click("sharedPresets.preview");
    await click("sharedPresets.apply");
    expect(container.textContent).toContain("Recipe changed; preview again");
    expect(container.textContent).toContain("testing");
  });

  it("checks at startup and hourly, notifying without applying", async () => {
    mocks.getFollowedPresets.mockResolvedValue([followed]);
    await render(true);
    expect(mocks.previewFollowedPreset).toHaveBeenCalledExactlyOnceWith(url);
    expect(mocks.info).toHaveBeenCalledOnce();
    expect(mocks.applyFollowedPreset).not.toHaveBeenCalled();
    expect(container.textContent).toContain("sharedPresets.updateAvailable");
    await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60 * 1000); });
    expect(mocks.previewFollowedPreset).toHaveBeenCalledTimes(2);
    expect(mocks.info).toHaveBeenCalledOnce();
    expect(mocks.applyFollowedPreset).not.toHaveBeenCalled();
    await click("sharedPresets.review");
    await click("sharedPresets.apply");
    expect(mocks.applyFollowedPreset).toHaveBeenCalledExactlyOnceWith(url, "new");
  });

  it("keeps its hourly schedule when the user navigates", async () => {
    mocks.getFollowedPresets.mockResolvedValue([followed]);
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(30 * 60 * 1000); });
    await click("navigate");
    await act(async () => { await vi.advanceTimersByTimeAsync(30 * 60 * 1000); });
    expect(mocks.previewFollowedPreset).toHaveBeenCalledTimes(2);
  });

  it("does not overlap slow checks and makes check errors visible", async () => {
    let reject!: (reason: unknown) => void;
    mocks.getFollowedPresets.mockResolvedValue([followed]);
    mocks.previewFollowedPreset.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60 * 1000); });
    expect(mocks.previewFollowedPreset).toHaveBeenCalledOnce();
    await act(async () => reject({ kind: "network", message: "Recipe offline" }));
    expect(container.textContent).toContain("Recipe offline");
    expect(mocks.error).toHaveBeenCalled();
  });

  it("unfollows without deleting the preset or its skills", async () => {
    mocks.getFollowedPresets.mockResolvedValue([followed]);
    await render();
    expect(container.textContent).toContain("sharedPresets.unfollowHint");
    await click("sharedPresets.unfollow");
    expect(mocks.unfollowPreset).toHaveBeenCalledExactlyOnceWith(url);
    expect(container.textContent).not.toContain("sharedPresets.updateAvailable");
    expect(mocks.applyFollowedPreset).not.toHaveBeenCalled();
  });

  it("exports a local preset as shareable JSON", async () => {
    await render();
    const select = container.querySelector("select")!;
    await act(async () => { select.value = "local"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await click("sharedPresets.copyRecipe");
    expect(mocks.exportPresetRecipe).toHaveBeenCalledExactlyOnceWith("local");
    expect(mocks.writeText).toHaveBeenCalledExactlyOnceWith(JSON.stringify(preview.recipe, null, 2));
    expect(container.textContent).toContain("sharedPresets.publishHint");
  });
});
