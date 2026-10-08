import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useParams } from "react-router-dom";

import { api, ApiError, tokens, type Identity, type Role } from "../../api";

export default function Guard({ role, children }: { role: Role; children: ReactNode }) {
  const { childId } = useParams();
  const [status, setStatus] = useState<"loading" | "ok" | "denied" | "error">("loading");
  const token = tokens.get(role);
  useEffect(() => {
    let active = true;
    setStatus("loading");
    if (!token) {
      setStatus("denied");
      return;
    }
    api<{ identity: Identity }>("/session", { role })
      .then(({ identity }) => {
        if (active)
          setStatus(
            identity.role === role && (role === "parent" || identity.id === childId)
              ? "ok"
              : "denied",
          );
      })
      .catch((e: unknown) => {
        if (active) setStatus(e instanceof ApiError && e.status === 401 ? "denied" : "error");
      });
    return () => {
      active = false;
    };
  }, [role, childId, token]);
  if (status === "loading") return <p>確認中…</p>;
  if (status === "error")
    return (
      <p className="rounded-lg bg-red-50 px-4 py-3 text-red-800" role="alert">
        接続できません。時間をおいて再読み込みしてください。
      </p>
    );
  if (status === "denied")
    return <Navigate to={role === "parent" ? "/" : `/child/login/${childId}`} replace />;
  return children;
}
