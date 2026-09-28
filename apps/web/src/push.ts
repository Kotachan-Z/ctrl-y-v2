export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export async function registerServiceWorker() {
  await navigator.serviceWorker.register("/sw.js");
  return navigator.serviceWorker.ready;
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void registerServiceWorker().catch(() => {
      // The notification control reports registration failures when used.
    });
  });
}
