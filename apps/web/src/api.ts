export type Role = "parent" | "child";
export type Identity = { role: Role; id: string; parentId?: string };
export type Child = { id: string; name: string };
const keys: Record<Role, string> = { parent: "ctrl-y.parent-token", child: "ctrl-y.child-token" };
const refreshKeys: Record<Role, string> = {
  parent: "ctrl-y.parent-refresh-token",
  child: "ctrl-y.child-refresh-token",
};
export const tokens = {
  get: (role: Role) => localStorage.getItem(keys[role]),
  getRefresh: (role: Role) => localStorage.getItem(refreshKeys[role]),
  set: (role: Role, token: string, refreshToken: string) => {
    localStorage.setItem(keys[role], token);
    localStorage.setItem(refreshKeys[role], refreshToken);
  },
  remove: (role: Role) => {
    const owner = tokenOwner(tokens.get(role));
    for (const entry of readQueue()) {
      if (identitiesMatch(role, owner, entry.owner))
        localStorage.removeItem(queuePrefix + entry.id);
    }
    localStorage.removeItem(keys[role]);
    localStorage.removeItem(refreshKeys[role]);
    notifyOffline();
  },
};
// Unverified claims are only a retry guard; the server still authenticates every request.
function tokenOwner(token: string | null): Identity | undefined {
  try {
    if (!token) return undefined;
    const encoded = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload: unknown = JSON.parse(
      atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")),
    );
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("sub" in payload) ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      !("role" in payload)
    )
      return undefined;
    if (payload.role === "parent") return { role: "parent", id: payload.sub };
    if (
      payload.role === "child" &&
      "parentId" in payload &&
      typeof payload.parentId === "string" &&
      payload.parentId
    )
      return { role: "child", id: payload.sub, parentId: payload.parentId };
  } catch {
    // Malformed or missing claims cannot establish that a retry has the same owner.
  }
  return undefined;
}
function sameOwner(role: Role, first: string | null, second: string | null) {
  return identitiesMatch(role, tokenOwner(first), tokenOwner(second));
}
function identitiesMatch(role: Role, a: Identity | undefined, b: Identity | undefined) {
  return (
    !!a && !!b && a.role === role && b.role === role && a.id === b.id && a.parentId === b.parentId
  );
}
const refreshing: Partial<Record<Role, Promise<{ refreshed: boolean; invalid?: boolean }>>> = {};
// Web Locks also serialize refresh/logout across tabs sharing localStorage.
const sessionLock = async <T>(role: Role, action: () => Promise<T>): Promise<T> =>
  typeof navigator !== "undefined" && navigator.locks
    ? await navigator.locks.request(`ctrl-y.session.${role}`, action)
    : action();
async function refreshSession(
  role: Role,
  failedToken: string | null,
): Promise<{ refreshed: boolean; invalid?: boolean }> {
  if (refreshing[role]) return refreshing[role];
  const pending = sessionLock(role, async () => {
    if (tokens.get(role) !== failedToken)
      return { refreshed: sameOwner(role, failedToken, tokens.get(role)) };
    const refreshToken = tokens.getRefresh(role);
    if (!refreshToken) {
      return { refreshed: false, invalid: true };
    }
    try {
      const response = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok)
        return {
          refreshed: false,
          invalid: response.status === 401 && tokens.getRefresh(role) === refreshToken,
        };
      const data = await response.json();
      if (typeof data.token !== "string" || typeof data.refreshToken !== "string")
        throw new Error("Refresh failed");
      // A login in another view must not be overwritten by an older request.
      if (tokens.getRefresh(role) === refreshToken) tokens.set(role, data.token, data.refreshToken);
      return { refreshed: sameOwner(role, failedToken, tokens.get(role)) };
    } catch {
      return { refreshed: false };
    }
  });
  refreshing[role] = pending;
  try {
    return await pending;
  } finally {
    if (refreshing[role] === pending) delete refreshing[role];
  }
}
export async function logout(role: Role) {
  await refreshing[role];
  await sessionLock(role, async () => {
    const refreshToken = tokens.getRefresh(role);
    if (refreshToken) await api("/auth/logout", { body: { refreshToken } });
    if (tokens.getRefresh(role) === refreshToken) tokens.remove(role);
  });
}
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
    response = await sendWithRefresh(path, method, token, body, options.role);
  } catch (error) {
    if (
      !(error instanceof TypeError) ||
      method !== "PATCH" ||
      !/^\/tasks\/[^/]+\/status$/.test(path) ||
      options.role !== "child" ||
      !body ||
      !isCompletionReport(options.role, body)
    )
      throw error;
    const owner = tokenOwner(token);
    if (!owner || !identitiesMatch(options.role, owner, tokenOwner(tokens.get(options.role))))
      throw error;
    const entry: QueuedOperation = {
      id: crypto.randomUUID(),
      path,
      body,
      owner,
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
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error ?? "通信に失敗しました", response.status);
  if (response.headers.get("X-Ctrl-Y-Offline") === "1") {
    window.dispatchEvent(new Event("ctrl-y-cached"));
  }
  // The caller supplies the response contract for this first-party API.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return data as T;
}

type QueuedOperation = {
  id: string;
  path: string;
  body: string;
  owner: Identity;
  role: Role;
  created: number;
};
const queuePrefix = "ctrl-y.offline-status.";
export function isOfflineQueueKey(key: string | null) {
  return key === null || key.startsWith(queuePrefix);
}
function isCompletionReport(role: Role, body: string) {
  try {
    const data = JSON.parse(body);
    return (
      role === "child" &&
      data !== null &&
      typeof data === "object" &&
      data.status === "WAIT_REVIEW" &&
      Object.keys(data).length === 1
    );
  } catch {
    return false;
  }
}
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
        entry.owner &&
        (entry.owner.role === "parent" || entry.owner.role === "child") &&
        entry.owner.role === entry.role &&
        typeof entry.owner.id === "string" &&
        entry.owner.id.length > 0 &&
        (entry.owner.parentId === undefined || typeof entry.owner.parentId === "string") &&
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
    (entry) =>
      (!role || entry.role === role) &&
      identitiesMatch(entry.role, entry.owner, tokenOwner(tokens.get(entry.role))),
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
// Both foreground requests and queue replay retry at most once, without consuming the body.
async function sendWithRefresh(
  path: string,
  method: string,
  token: string | null,
  body: string | undefined,
  role?: Role,
  retainQueue = false,
): Promise<Response> {
  let response = await send(path, method, token, body);
  if (response.status !== 401 || !role) return response;
  let rejectedToken = token;
  let invalid = path.startsWith("/auth/");
  if (!invalid) {
    const result = await refreshSession(role, token);
    invalid = result.invalid ?? false;
    const retryToken = tokens.get(role);
    if (result.refreshed && sameOwner(role, token, retryToken)) {
      rejectedToken = retryToken;
      response = await send(path, method, retryToken, body);
      invalid = response.status === 401;
      if (retainQueue && !response.ok)
        throw new ApiError("送信待ちの操作を再送できませんでした", response.status);
    }
  }
  // Transient refresh failures retain credentials. Never clear a newer login's session.
  // Replay retains the entry on authorization failure so it can be retried later.
  if (invalid && !retainQueue && tokens.get(role) === rejectedToken) tokens.remove(role);
  return response;
}
let replay: Promise<void> | undefined;
export function replayOfflineOperations(): Promise<void> {
  if (replay) return replay;
  async function drain() {
    for (const entry of pendingOperations()) {
      // Discard operations saved by older versions that queued other transitions.
      if (!isCompletionReport(entry.role, entry.body)) {
        localStorage.removeItem(queuePrefix + entry.id);
        notifyOffline("完了報告以外の古い送信待ち操作を破棄しました");
        continue;
      }
      // Recheck after each await: logout/account switching can happen during replay.
      const token = tokens.get(entry.role);
      if (
        !identitiesMatch(entry.role, entry.owner, tokenOwner(token)) ||
        !localStorage.getItem(queuePrefix + entry.id)
      )
        continue;
      let response;
      try {
        response = await sendWithRefresh(entry.path, "PATCH", token, entry.body, entry.role, true);
        if (
          response.status === 401 ||
          !identitiesMatch(entry.role, entry.owner, tokenOwner(tokens.get(entry.role)))
        )
          break;
      } catch (error) {
        if (!(error instanceof TypeError) && !(error instanceof ApiError)) throw error;
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
  const visible = () => {
    if (document.visibilityState === "visible") retry();
  };
  document.addEventListener("visibilitychange", visible);
  retry();
  return () => {
    window.removeEventListener("online", retry);
    document.removeEventListener("visibilitychange", visible);
  };
}
