export type Role = "parent" | "child";
export type Identity = { role: Role; id: string; parentId?: string };
export type Child = { id: string; name: string };
const keys: Record<Role, string> = { parent: "ctrl-y.parent-token", child: "ctrl-y.child-token" };
export const tokens = {
  get: (role: Role) => localStorage.getItem(keys[role]),
  set: (role: Role, token: string) => localStorage.setItem(keys[role], token),
  remove: (role: Role) => {
    const token = tokens.get(role);
    for (const entry of readQueue()) {
      if (entry.token === token) localStorage.removeItem(queuePrefix + entry.id);
    }
    localStorage.removeItem(keys[role]);
    notifyOffline();
  },
};
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: {
    body?: unknown;
    role?: Role;
    method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  } = {},
): Promise<T> {
  const token = options.role ? tokens.get(options.role) : null;
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  let response;
  try {
    response = await send(path, method, token, body);
  } catch (error) {
    if (
      !(error instanceof TypeError) ||
      method !== "PATCH" ||
      !/^\/tasks\/[^/]+\/status$/.test(path) ||
      !token ||
      !options.role ||
      !body
    )
      throw error;
    const entry: QueuedOperation = {
      id: crypto.randomUUID(),
      path,
      body,
      token,
      role: options.role,
      created: Date.now(),
    };
    // If persistence fails, report the error instead of claiming the operation was saved.
    localStorage.setItem(queuePrefix + entry.id, JSON.stringify(entry));
    notifyOffline("オフラインのため送信待ちです");
    // Callers of the status endpoint explicitly handle the queued response.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    return { queued: true } as T;
  }
  if (response.headers.get("X-Ctrl-Y-Offline") === "1") {
    window.dispatchEvent(new Event("ctrl-y-cached"));
  }
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && options.role) tokens.remove(options.role);
    throw new ApiError(data.error ?? "通信に失敗しました", response.status);
  }
  // The caller supplies the response contract for this first-party API.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return data as T;
}

type QueuedOperation = {
  id: string;
  path: string;
  body: string;
  token: string;
  role: Role;
  created: number;
};
const queuePrefix = "ctrl-y.offline-status.";
export const offlineEvent = "ctrl-y-offline";
export const syncEvent = "ctrl-y-synced";
function readQueue(): QueuedOperation[] {
  const entries: QueuedOperation[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(queuePrefix)) continue;
    try {
      const entry: QueuedOperation = JSON.parse(localStorage.getItem(key) ?? "null");
      if (
        entry &&
        typeof entry.id === "string" &&
        typeof entry.token === "string" &&
        (entry.role === "parent" || entry.role === "child") &&
        typeof entry.body === "string" &&
        typeof entry.path === "string" &&
        /^\/tasks\/[^/]+\/status$/.test(entry.path) &&
        typeof entry.created === "number"
      )
        entries.push(entry);
    } catch {
      /* Ignore invalid local data. */
    }
  }
  // oxlint-disable-next-line unicorn/no-array-sort
  return entries.sort((a, b) => a.created - b.created);
}
export function pendingOperations(role?: Role) {
  return readQueue().filter(
    (entry) => (!role || entry.role === role) && tokens.get(entry.role) === entry.token,
  );
}
function notifyOffline(message = "") {
  window.dispatchEvent(new CustomEvent(offlineEvent, { detail: message }));
}
function send(path: string, method: string, token: string | null, body?: string) {
  return fetch(`/api${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
}
let replay: Promise<void> | undefined;
export function replayOfflineOperations(): Promise<void> {
  if (replay) return replay;
  async function drain() {
    for (const entry of pendingOperations()) {
      // Recheck after each await: logout/account switching can happen during replay.
      if (tokens.get(entry.role) !== entry.token || !localStorage.getItem(queuePrefix + entry.id))
        continue;
      let response;
      try {
        response = await send(entry.path, "PATCH", entry.token, entry.body);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        break;
      }
      localStorage.removeItem(queuePrefix + entry.id);
      notifyOffline(
        response.ok
          ? "送信待ちの操作を送信しました"
          : `送信待ちの操作に失敗しました（HTTP ${response.status}）。タスクの状態を確認してください。`,
      );
      window.dispatchEvent(new Event(syncEvent));
    }
  }
  // Serialize replay across tabs where Web Locks is available; no Background Sync dependency.
  replay = (async () => {
    if (navigator.locks) await navigator.locks.request("ctrl-y-offline-replay", drain);
    else await drain();
  })().finally(() => {
    replay = undefined;
  });
  return replay;
}
export function startOfflineReplay() {
  const retry = () => {
    void replayOfflineOperations().catch(() =>
      notifyOffline("送信待ちの操作を処理できませんでした。再度アプリを開いてください。"),
    );
  };
  window.addEventListener("online", retry);
  retry();
  return () => window.removeEventListener("online", retry);
}
