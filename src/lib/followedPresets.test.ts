import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { applyFollowedPreset, exportPresetRecipe, getFollowedPresets, previewFollowedPreset, unfollowPreset } from "./tauri";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

describe("followed preset command arguments", () => {
  it("binds an apply to its reviewed source and revision", async () => {
    await applyFollowedPreset("https://github.com/owner/repo/blob/main/preset.json", "reviewed-hash");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("apply_followed_preset", {
      sourceUrl: "https://github.com/owner/repo/blob/main/preset.json", expectedRevision: "reviewed-hash",
    });
  });
  it("uses the backend preview, subscriptions, unfollow and export commands", async () => {
    await previewFollowedPreset("source-url");
    await getFollowedPresets();
    await unfollowPreset("source-url");
    await exportPresetRecipe("preset-id");
    expect(invoke).toHaveBeenNthCalledWith(1, "preview_followed_preset", { sourceUrl: "source-url" });
    expect(invoke).toHaveBeenNthCalledWith(2, "get_followed_presets");
    expect(invoke).toHaveBeenNthCalledWith(3, "unfollow_preset", { sourceUrl: "source-url" });
    expect(invoke).toHaveBeenNthCalledWith(4, "export_preset_recipe", { presetId: "preset-id" });
  });
});
