import { useRef, useState } from "react";
import { Copy, Link2, RefreshCw } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useApp } from "../context/AppContext";
import { useSharedPresets } from "../context/SharedPresetsContext";
import { getErrorMessage } from "../lib/error";
import { exportPresetRecipe, type FollowedPresetPreview } from "../lib/tauri";

const buttonClass = "inline-flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-1.5 text-[13px] text-secondary hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed";

export function SharedPresets() {
  const { t } = useTranslation();
  const { presets } = useApp();
  const shared = useSharedPresets();
  const [sourceUrl, setSourceUrl] = useState("");
  const [approved, setApproved] = useState<FollowedPresetPreview | null>(null);
  const [presetId, setPresetId] = useState("");
  const [pageError, setPageError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const inFlight = useRef(false);
  const busy = shared.busy || working;

  const act = async (action: () => Promise<void>) => {
    if (inFlight.current || shared.busy) return;
    inFlight.current = true;
    setWorking(true);
    setPageError(null);
    try {
      await action();
    } catch (err) {
      setPageError(getErrorMessage(err, t("common.error")));
    } finally {
      inFlight.current = false;
      setWorking(false);
    }
  };
  const preview = (url: string) => act(async () => {
    setApproved(null);
    setApproved(await shared.preview(url.trim()));
  });

  return (
    <div className="w-full space-y-5">
      <header>
        <h1 className="flex items-center gap-2 text-[17px] font-semibold text-primary"><Link2 className="h-5 w-5" />{t("sharedPresets.title")}</h1>
        <p className="mt-2 text-[13px] text-muted">{t("sharedPresets.description")}</p>
      </header>
      {(pageError || shared.error) && <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-[13px] text-red-600 dark:text-red-400">{pageError || shared.error}</p>}

      <section className="space-y-3 rounded-xl border border-border bg-surface p-4">
        <h2 className="text-[14px] font-medium text-primary">{t("sharedPresets.followTitle")}</h2>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void preview(sourceUrl); }}>
          <label className="min-w-0 flex-1 space-y-1 text-[12px] text-muted">
            <span>{t("sharedPresets.urlLabel")}</span>
            <input type="url" value={sourceUrl} onChange={(event) => { setSourceUrl(event.target.value); setApproved(null); }} disabled={busy} required placeholder={t("sharedPresets.urlPlaceholder")} className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-primary outline-none focus:border-accent" />
          </label>
          <button type="submit" disabled={busy || !sourceUrl.trim()} className={buttonClass}>{t("sharedPresets.preview")}</button>
        </form>
      </section>

      {approved && <section aria-label={t("sharedPresets.preview")} className="space-y-3 rounded-xl border border-accent/40 bg-surface p-4">
        <h2 className="text-[14px] font-medium text-primary">{approved.recipe.name}</h2>
        {approved.recipe.description && <p className="text-[13px] text-secondary">{approved.recipe.description}</p>}
        <p className="break-all text-[12px] text-muted">{approved.source_url}</p>
        <p className="break-all text-[11px] text-faint">{t("sharedPresets.revision", { revision: approved.revision })}</p>
        <div className="space-y-1 text-[13px] text-secondary">
          <h3 className="font-medium">{t("sharedPresets.members")}</h3>
          <ul className="space-y-1">
            {approved.recipe.skills.map((skill) => <li key={skill.name} className="break-all">{skill.name}<span className="ml-2 text-[12px] text-muted">{skill.install_ref}</span></li>)}
          </ul>
        </div>
        {([
          ["sharedPresets.additions", approved.additions],
          ["sharedPresets.removals", approved.removals],
          ["sharedPresets.conflicts", approved.conflicts],
        ] as const).map(([key, names]) => <div key={key} className="text-[13px] text-secondary">
          <h3 className="font-medium">{t(key)}</h3>
          <p className="break-words">{names.length ? names.join(", ") : t("sharedPresets.none")}</p>
        </div>)}
        <p className="text-[12px] text-muted">{t("sharedPresets.removalHint")}</p>
        {approved.conflicts.length > 0 && <p role="alert" className="text-[13px] text-red-600 dark:text-red-400">{t("sharedPresets.conflictHint")}</p>}
        <p className="text-[12px] text-muted">{t("sharedPresets.deployHint")}</p>
        <div className="flex gap-2">
          <button disabled={busy || approved.conflicts.length > 0} className={buttonClass} onClick={() => void act(async () => {
            await shared.apply(approved);
            setApproved(null);
            setSourceUrl("");
            toast.success(t("sharedPresets.applied"));
          })}>{t("sharedPresets.apply")}</button>
          <button disabled={busy} className={buttonClass} onClick={() => setApproved(null)}>{t("common.cancel")}</button>
        </div>
      </section>}

      <section className="space-y-3 rounded-xl border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[14px] font-medium text-primary">{t("sharedPresets.followedTitle")}</h2>
          <button disabled={busy} className={buttonClass} onClick={() => void shared.checkAll()}><RefreshCw className="h-4 w-4" />{t("sharedPresets.checkAll")}</button>
        </div>
        <p className="text-[12px] text-muted">{t("sharedPresets.checkHint")}</p>
        {!shared.loaded && <p className="text-[13px] text-muted">{t("common.loading")}</p>}
        {shared.loaded && shared.followed.length === 0 && <p className="text-[13px] text-muted">{t("sharedPresets.empty")}</p>}
        {shared.followed.map((subscription) => {
          const checked = shared.previews[subscription.source_url];
          const changed = checked && checked.revision !== subscription.revision;
          return <article key={subscription.source_url} className="space-y-2 rounded-xl border border-border-subtle p-3">
            <h3 className="text-[14px] font-medium text-primary">{subscription.name}</h3>
            <p className="break-all text-[12px] text-muted">{subscription.source_url}</p>
            <p className="text-[12px] text-secondary">{t(shared.checkErrors[subscription.source_url] ? "sharedPresets.checkUnavailable" : changed ? "sharedPresets.updateAvailable" : checked ? "sharedPresets.upToDate" : "sharedPresets.notChecked")}</p>
            {shared.checkErrors[subscription.source_url] && <p role="alert" className="text-[13px] text-red-600 dark:text-red-400">{shared.checkErrors[subscription.source_url]}</p>}
            <div className="flex flex-wrap gap-2">
              <button disabled={busy} className={buttonClass} onClick={() => void preview(subscription.source_url)}>{t("sharedPresets.check")}</button>
              {changed && <button disabled={busy} className={buttonClass} onClick={() => { setApproved(checked); setPageError(null); }}>{t("sharedPresets.review")}</button>}
              <button disabled={busy} className={buttonClass} onClick={() => void act(async () => {
                await shared.unfollow(subscription.source_url);
                if (approved?.source_url === subscription.source_url) setApproved(null);
                toast.success(t("sharedPresets.unfollowed"));
              })}>{t("sharedPresets.unfollow")}</button>
            </div>
          </article>;
        })}
        <p className="text-[12px] text-muted">{t("sharedPresets.unfollowHint")}</p>
      </section>

      <section className="space-y-3 rounded-xl border border-border bg-surface p-4">
        <h2 className="text-[14px] font-medium text-primary">{t("sharedPresets.shareTitle")}</h2>
        <p className="text-[13px] text-muted">{t("sharedPresets.publishHint")}</p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 space-y-1 text-[12px] text-muted">
            <span>{t("sharedPresets.localPreset")}</span>
            <select value={presetId} onChange={(event) => setPresetId(event.target.value)} disabled={busy} className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-primary">
              <option value="">{t("sharedPresets.choosePreset")}</option>
              {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
            </select>
          </label>
          <button disabled={busy || !presetId} className={buttonClass} onClick={() => void act(async () => {
            const recipe = await exportPresetRecipe(presetId);
            await writeText(JSON.stringify(recipe, null, 2));
            toast.success(t("sharedPresets.copied"));
          })}><Copy className="h-4 w-4" />{t("sharedPresets.copyRecipe")}</button>
        </div>
      </section>
    </div>
  );
}
