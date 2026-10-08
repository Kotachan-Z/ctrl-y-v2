import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api, ApiError } from "../../api";
import { inputClass, linkClass, cardClass } from "../../styles/shared";

type PayrollSettings = { payDay: boolean; cutoffDay: boolean };

export default function SalarySettings() {
  const navigate = useNavigate();
  const [settings, setSettings] = useState<PayrollSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    api<{ settings: PayrollSettings }>("/settings/payroll", { role: "parent" })
      .then((result) => {
        if (active) setSettings(result.settings);
      })
      .catch((e: unknown) => {
        if (!active) return;
        if (e instanceof ApiError && e.status === 401) void navigate("/", { replace: true });
        else setMessage(e instanceof Error ? e.message : "通信に失敗しました");
      });
    return () => {
      active = false;
    };
  }, [navigate]);
  async function update(key: keyof PayrollSettings, value: boolean) {
    setSaving(true);
    setMessage("");
    try {
      const result = await api<{ settings: PayrollSettings }>("/settings/payroll", {
        role: "parent",
        method: "PATCH",
        body: { [key]: value },
      });
      setSettings(result.settings);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) void navigate("/", { replace: true });
      else setMessage(e instanceof Error ? e.message : "通信に失敗しました");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="mx-auto max-w-xl space-y-6 py-6 sm:py-10">
      <h1 className="text-center text-3xl font-extrabold sm:text-4xl">給与設定</h1>
      {message && (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-red-800" role="alert">
          {message}
        </p>
      )}
      {!settings ? (
        <p className={cardClass}>読み込み中…</p>
      ) : (
        <div className={`${cardClass} space-y-6`}>
          <label className="grid gap-1 font-semibold">
            給料日
            <select
              className={inputClass}
              value={settings.payDay ? "15" : "end"}
              disabled={saving}
              onChange={(e) => void update("payDay", e.target.value === "15")}
            >
              <option value="end">月末</option>
              <option value="15">15日</option>
            </select>
          </label>
          <label className="grid gap-1 font-semibold">
            締め日
            <select
              className={inputClass}
              value={settings.cutoffDay ? "15" : "end"}
              disabled={saving}
              onChange={(e) => void update("cutoffDay", e.target.value === "15")}
            >
              <option value="end">月末</option>
              <option value="15">15日</option>
            </select>
          </label>
        </div>
      )}
      <Link className={linkClass} to="/settings">
        設定へ戻る
      </Link>
    </div>
  );
}
