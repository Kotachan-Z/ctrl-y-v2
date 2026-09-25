export type Role = "parent" | "child";
export type Identity = { role: Role; id: string; parentId?: string };
export type Child = { id: string; name: string };
const keys: Record<Role, string> = { parent: "ctrl-y.parent-token", child: "ctrl-y.child-token" };
export const tokens = {
  get: (role: Role) => localStorage.getItem(keys[role]),
  set: (role: Role, token: string) => localStorage.setItem(keys[role], token),
  remove: (role: Role) => localStorage.removeItem(keys[role]),
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
  options: { body?: unknown; role?: Role; method?: "GET" | "POST" | "PATCH" | "DELETE" } = {},
): Promise<T> {
  const token = options.role ? tokens.get(options.role) : null;
  const response = await fetch(`/api${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && options.role) tokens.remove(options.role);
    throw new ApiError(data.error ?? "通信に失敗しました", response.status);
  }
  // The caller supplies the response contract for this first-party API.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return data as T;
}
