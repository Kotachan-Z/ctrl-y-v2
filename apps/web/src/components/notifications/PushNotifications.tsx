import { useEffect, useState } from "react";

import { api } from "../../api";
import { registerServiceWorker, urlBase64ToUint8Array } from "../../push";
import { primaryButton, neutralButton, cardClass } from "../../styles/shared";

export default function PushNotifications() {
  const supported =
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(supported);
  const [message, setMessage] = useState(supported ? "" : "この環境では通知を利用できません");
  useEffect(() => {
    if (!supported) return;
    let active = true;
    registerServiceWorker()
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => {
        if (active) setEnabled(subscription !== null);
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
    setBusy(true);
    setMessage("");
    try {
      if (!enabled && (await Notification.requestPermission()) !== "granted") {
        setMessage("通知が許可されていません。ブラウザの設定を確認してください");
        return;
      }
      const registration = await registerServiceWorker();
      const subscription = await registration.pushManager.getSubscription();
      if (enabled) {
        if (subscription) await subscription.unsubscribe();
        await api("/parents/push-subscription", { role: "parent", method: "DELETE" });
        setEnabled(false);
        setMessage("通知を無効にしました");
      } else {
        const { publicKey } = await api<{ publicKey: string }>("/push/public-key");
        const next =
          subscription ??
          (await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
          }));
        try {
          await api("/parents/push-subscription", {
            role: "parent",
            method: "PUT",
            body: next.toJSON(),
          });
        } catch (e) {
          if (!subscription) await next.unsubscribe();
          throw e;
        }
        setEnabled(true);
        setMessage("通知を有効にしました");
      }
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
