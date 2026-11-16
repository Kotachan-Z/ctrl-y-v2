import { useEffect, useRef, useState } from "react";

import { api, ApiError, bumpPushGeneration, pushGeneration, pushSubscriptionLock } from "../../api";
import { registerServiceWorker, urlBase64ToUint8Array } from "../../push";
import { primaryButton, neutralButton, cardClass } from "../../styles/shared";

export default function PushNotifications() {
  const supported =
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(supported);
  const [message, setMessage] = useState(supported ? "" : "この環境では通知を利用できません");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!supported) return;
    let active = true;
    registerServiceWorker()
      .then((registration) =>
        pushSubscriptionLock(async () => {
          const subscription = await registration.pushManager.getSubscription();
          if (!subscription) return false;
          // An unmounted page must not re-register after a later unsubscribe.
          if (!active) return true;
          // Re-register so the server copy matches this browser: it may have been evicted by
          // the per-parent device limit or still belong to a parent who logged out here.
          try {
            await api("/parents/push-subscription", {
              role: "parent",
              method: "PUT",
              body: subscription.toJSON(),
            });
          } catch (e) {
            // 409: another parent owns this browser's subscription, and enabling resubscribes
            // it. Any other failure falls back to the browser's own state, as before.
            return !(e instanceof ApiError && e.status === 409);
          }
          return true;
        }),
      )
      .then((subscribed) => {
        if (active) setEnabled(subscribed);
      })
      .catch(() => {
        if (active) setMessage("通知の設定を確認できませんでした");
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [supported]);
  async function toggle() {
    // Read synchronously at the click, before any await, to detect later changes elsewhere.
    const generation = pushGeneration();
    setBusy(true);
    setMessage("");
    try {
      // Ask before waiting on the lock: Safari only shows the prompt during the click.
      if (!enabled && (await Notification.requestPermission()) !== "granted") {
        setMessage("通知が許可されていません。ブラウザの設定を確認してください");
        return;
      }
      await pushSubscriptionLock(async () => {
        const registration = await registerServiceWorker();
        const subscription = await registration.pushManager.getSubscription();
        // The page was left, or another tab (or a logout) changed the subscription while this
        // click waited for permission or the lock; acting now would undo that newer action.
        if (!mounted.current) return;
        if (pushGeneration() !== generation) {
          setEnabled(subscription !== null);
          setMessage("別の画面で通知の設定が変わりました。必要ならもう一度操作してください");
          return;
        }
        bumpPushGeneration();
        if (enabled) {
          if (subscription) {
            await api("/parents/push-subscription", {
              role: "parent",
              method: "DELETE",
              body: { endpoint: subscription.endpoint },
            });
            await subscription.unsubscribe();
          }
          setEnabled(false);
          setMessage("通知を無効にしました");
        } else {
          const { publicKey } = await api<{ publicKey: string }>("/push/public-key");
          let next =
            subscription ??
            (await registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(publicKey),
            }));
          const save = () =>
            api("/parents/push-subscription", {
              role: "parent",
              method: "PUT",
              body: next.toJSON(),
            });
          let created = !subscription;
          try {
            try {
              await save();
            } catch (e) {
              if (!(e instanceof ApiError) || e.status !== 409) throw e;
              await next.unsubscribe();
              next = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey),
              });
              created = true;
              await save();
            }
          } catch (e) {
            if (created) await next.unsubscribe();
            throw e;
          }
          setEnabled(true);
          setMessage("通知を有効にしました");
        }
      });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "通知の設定に失敗しました");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className={`${cardClass} flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between`}
    >
      <div className="flex items-center gap-4">
        <img
          src="/images/icon-notice.png"
          alt=""
          width="48"
          height="48"
          className="h-11 w-11 shrink-0 object-contain sm:h-12 sm:w-12"
        />
        <div>
          <h2 className="text-xl font-bold">通知</h2>
          <p className="text-sm text-[#5C410E]/70">
            お子様がタスクを完了報告したときにお知らせします
          </p>
        </div>
      </div>
      <div className="flex flex-col items-start gap-2 sm:items-end">
        <button
          className={enabled ? neutralButton : primaryButton}
          disabled={!supported || busy}
          onClick={toggle}
        >
          {busy ? "確認中…" : enabled ? "通知を無効にする" : "通知を有効にする"}
        </button>
        {message && (
          <p className="rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-900" role="status">
            {message}
          </p>
        )}
      </div>
    </section>
  );
}
