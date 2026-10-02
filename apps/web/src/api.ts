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
    localStorage.removeItem(keys[role]);
    localStorage.removeItem(refreshKeys[role]);
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
  const a = tokenOwner(first);
  const b = tokenOwner(second);
  return (
    !!a && !!b && a.role === role && b.role === role && a.id === b.id && a.parentId === b.parentId
  );
}
const refreshing: Partial<Record<Role, Promise<boolean>>> = {};
// Web Locks also serialize refresh/logout across tabs sharing localStorage.
const sessionLock = async <T>(role: Role, action: () => Promise<T>): Promise<T> =>
  typeof navigator !== "undefined" && navigator.locks
    ? await navigator.locks.request(`ctrl-y.session.${role}`, action)
    : action();
async function refreshSession(role: Role, failedToken: string | null): Promise<boolean> {
  if (refreshing[role]) return refreshing[role];
  const pending = sessionLock(role, async () => {
    if (tokens.get(role) !== failedToken) return sameOwner(role, failedToken, tokens.get(role));
    const refreshToken = tokens.getRefresh(role);
    if (!refreshToken) {
      tokens.remove(role);
      return false;
    }
    try {
      const response = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (response.status === 401 && tokens.getRefresh(role) === refreshToken) tokens.remove(role);
      if (!response.ok) return false;
      const data = await response.json();
      if (typeof data.token !== "string" || typeof data.refreshToken !== "string")
        throw new Error("Refresh failed");
      // A login in another view must not be overwritten by an older request.
      if (tokens.getRefresh(role) === refreshToken) tokens.set(role, data.token, data.refreshToken);
      return sameOwner(role, failedToken, tokens.get(role));
    } catch {
      return false;
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
  const send = (token: string | null) =>
    fetch(`/api${path}`, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers: {
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  const token = options.role ? tokens.get(options.role) : null;
  let response = await send(token);
  if (response.status === 401 && options.role && !path.startsWith("/auth/")) {
    if (await refreshSession(options.role, token)) {
      const retryToken = tokens.get(options.role);
      if (!sameOwner(options.role, token, retryToken)) {
        const data = await response.json();
        throw new ApiError(data.error ?? "通信に失敗しました", response.status);
      }
      response = await send(retryToken);
      if (response.status === 401 && tokens.get(options.role) === retryToken)
        tokens.remove(options.role);
    }
  }
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error ?? "通信に失敗しました", response.status);
  // The caller supplies the response contract for this first-party API.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return data as T;
}
