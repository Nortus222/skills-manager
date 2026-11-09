/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useApp } from "./AppContext";
import { getErrorMessage } from "../lib/error";
import * as api from "../lib/tauri";
import type { FollowedPreset, FollowedPresetPreview } from "../lib/tauri";

interface SharedPresetsState {
  followed: FollowedPreset[];
  previews: Record<string, FollowedPresetPreview>;
  checkErrors: Record<string, string>;
  error: string | null;
  busy: boolean;
  loaded: boolean;
  checkAll: () => Promise<void>;
  preview: (sourceUrl: string) => Promise<FollowedPresetPreview>;
  apply: (preview: FollowedPresetPreview) => Promise<void>;
  unfollow: (sourceUrl: string) => Promise<void>;
}

const SharedPresetsContext = createContext<SharedPresetsState | null>(null);

export function SharedPresetsProvider({ children }: { children: ReactNode }) {
  const { loading, refreshPresets, refreshManagedSkills } = useApp();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [followed, setFollowed] = useState<FollowedPreset[]>([]);
  const [previews, setPreviews] = useState<Record<string, FollowedPresetPreview>>({});
  const [checkErrors, setCheckErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const inFlight = useRef(false);
  const started = useRef(false);
  const ready = useRef(false);
  const notified = useRef(new Map<string, string>());

  // Background checks and user writes share the same guard.
  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    if (inFlight.current) throw new Error(t("sharedPresets.busy"));
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (err) {
      setError(getErrorMessage(err, t("common.error")));
      throw err;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [t]);

  const checkAll = useCallback(async () => {
    if (inFlight.current) return;
    try {
      await run(async () => {
        const subscriptions = await api.getFollowedPresets();
        setFollowed(subscriptions);
        for (const subscription of subscriptions) {
          try {
            const result = await api.previewFollowedPreset(subscription.source_url);
            setPreviews((current) => ({ ...current, [subscription.source_url]: result }));
            setCheckErrors((current) => ({ ...current, [subscription.source_url]: "" }));
            if (result.revision !== subscription.revision && notified.current.get(subscription.source_url) !== result.revision) {
              notified.current.set(subscription.source_url, result.revision);
              toast.info(t("sharedPresets.updateNotification", { name: subscription.name }), {
                id: `followed-preset:${subscription.source_url}`,
                action: { label: t("sharedPresets.review"), onClick: () => navigate("/shared-presets") },
              });
            }
          } catch (err) {
            const message = getErrorMessage(err, t("common.error"));
            setCheckErrors((current) => ({ ...current, [subscription.source_url]: message }));
            toast.error(t("sharedPresets.checkFailed", { name: subscription.name, message }));
          }
        }
      });
    } catch (err) {
      toast.error(getErrorMessage(err, t("common.error")));
    } finally {
      setLoaded(true);
    }
  }, [navigate, run, t]);

  const checkAllRef = useRef(checkAll);
  useEffect(() => { checkAllRef.current = checkAll; }, [checkAll]);
  useEffect(() => { ready.current = !loading; }, [loading]);
  useEffect(() => {
    if (loading || started.current) return;
    // A timer also lets StrictMode cancel its first setup before any fetch.
    const timer = setTimeout(() => {
      started.current = true;
      void checkAll();
    }, 0);
    return () => clearTimeout(timer);
  }, [loading, checkAll]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (ready.current) void checkAllRef.current();
    }, 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  const preview = (sourceUrl: string) => run(async () => {
    const result = await api.previewFollowedPreset(sourceUrl);
    setPreviews((current) => ({ ...current, [result.source_url]: result }));
    setCheckErrors((current) => ({ ...current, [result.source_url]: "" }));
    return result;
  });
  const apply = (approved: FollowedPresetPreview) => run(async () => {
    const result = await api.applyFollowedPreset(approved.source_url, approved.revision);
    setFollowed((current) => [...current.filter((item) => item.source_url !== result.source_url), result]);
    setPreviews((current) => {
      const next = { ...current };
      delete next[approved.source_url];
      return next;
    });
    notified.current.delete(approved.source_url);
    await Promise.all([refreshPresets(), refreshManagedSkills()]);
  });
  const unfollow = (sourceUrl: string) => run(async () => {
    await api.unfollowPreset(sourceUrl);
    setFollowed((current) => current.filter((item) => item.source_url !== sourceUrl));
    setPreviews((current) => {
      const next = { ...current };
      delete next[sourceUrl];
      return next;
    });
    notified.current.delete(sourceUrl);
  });

  return <SharedPresetsContext.Provider value={{ followed, previews, checkErrors, error, busy, loaded, checkAll, preview, apply, unfollow }}>
    {children}
  </SharedPresetsContext.Provider>;
}

export function useSharedPresets() {
  const context = useContext(SharedPresetsContext);
  if (!context) throw new Error("useSharedPresets must be used within SharedPresetsProvider");
  return context;
}
