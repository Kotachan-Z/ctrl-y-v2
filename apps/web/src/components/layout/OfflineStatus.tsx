import { useEffect, useState } from "react";

import { offlineEvent, pendingOperations, startOfflineReplay } from "../../api";

export default function OfflineStatus() {
  const [offline, setOffline] = useState(!navigator.onLine);
  const [cached, setCached] = useState(false);
  const [count, setCount] = useState(0);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const connection = () => setOffline(!navigator.onLine);
    const cacheUsed = () => setCached(true);
    let active = true;
    let revision = 0;
    const update = (event?: Event) => {
      const current = ++revision;
      void pendingOperations().then((operations) => {
        if (active && current === revision) setCount(operations.length);
      });
      if (event instanceof CustomEvent && typeof event.detail === "string")
        setMessage(event.detail);
    };
    window.addEventListener("online", connection);
    window.addEventListener("offline", connection);
    window.addEventListener("ctrl-y-cached", cacheUsed);
    window.addEventListener(offlineEvent, update);
    window.addEventListener("storage", update);
    update();
    const stop = startOfflineReplay();
    return () => {
      active = false;
      stop();
      window.removeEventListener("online", connection);
      window.removeEventListener("offline", connection);
      window.removeEventListener("ctrl-y-cached", cacheUsed);
      window.removeEventListener(offlineEvent, update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return (
    <aside className="text-center text-sm" aria-live="polite">
      {(offline || cached) && (
        <p>
          オフライン表示中（最終更新:
          直前の取得結果）。最新情報はオンラインで再読み込みしてください。
        </p>
      )}
      {count > 0 && <p>未送信の操作: {count}件</p>}
      {message && <p>{message}</p>}
    </aside>
  );
}
