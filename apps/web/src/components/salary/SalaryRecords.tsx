import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api, ApiError, type Child } from "../../api";
import { inputClass, linkClass, cardClass } from "../../styles/shared";

type PayrollRow = {
  id: string;
  childId: string;
  month: string;
  completedTaskCount: number;
  totalReward: number;
};

export default function SalaryRecords() {
  const navigate = useNavigate();
  const [children, setChildren] = useState<Child[]>([]);
  const [childrenLoaded, setChildrenLoaded] = useState(false);
  const [selectedChild, setSelectedChild] = useState("");
  const [rows, setRows] = useState<PayrollRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  useEffect(() => {
    let active = true;
    api<{ children: Child[] }>("/children", { role: "parent" })
      .then((result) => {
        if (!active) return;
        setChildren(result.children);
        setChildrenLoaded(true);
        if (result.children.length > 0) setSelectedChild(result.children[0].id);
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
  useEffect(() => {
    if (!selectedChild) return;
    let active = true;
    setLoaded(false);
    setMessage("");
    api<{ payroll: PayrollRow[] }>(`/children/${selectedChild}/payroll`, { role: "parent" })
      .then((result) => {
        if (active) {
          setRows(result.payroll);
          setLoaded(true);
        }
      })
      .catch((e: unknown) => {
        if (!active) return;
        if (e instanceof ApiError && e.status === 401) void navigate("/", { replace: true });
        else setMessage(e instanceof Error ? e.message : "通信に失敗しました");
      });
    return () => {
      active = false;
    };
  }, [selectedChild, navigate]);
  const years = useMemo(() => {
    const set = new Set(rows.map((row) => Number(row.month.slice(0, 4))));
    set.add(new Date().getFullYear());
    // Keep the current selection available even when switching to a child with no
    // records for that year, so the <select> never drifts out of sync with `selectedYear`.
    set.add(selectedYear);
    // Array.from(set) is already a fresh array, so sorting it in place is safe.
    // oxlint-disable-next-line unicorn/no-array-sort
    return Array.from(set).sort((a: number, b: number) => b - a);
  }, [rows, selectedYear]);
  const months = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => {
        const monthKey = `${selectedYear}-${String(i + 1).padStart(2, "0")}-01`;
        const row = rows.find((r) => r.month.slice(0, 10) === monthKey);
        return { month: i + 1, count: row?.completedTaskCount ?? 0, reward: row?.totalReward ?? 0 };
      }),
    [rows, selectedYear],
  );
  const maxReward = Math.max(1, ...months.map((m) => m.reward));
  const yearTotal = months.reduce((sum, m) => sum + m.reward, 0);
  const yearCount = months.reduce((sum, m) => sum + m.count, 0);
  return (
    <div className="mx-auto max-w-4xl space-y-6 py-6 sm:py-10">
      <h1 className="text-center text-3xl font-extrabold sm:text-4xl">給与記録</h1>
      {message && (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-red-800" role="alert">
          {message}
        </p>
      )}
      {childrenLoaded && children.length === 0 ? (
        <p className={cardClass}>子供が登録されていません。</p>
      ) : (
        <>
          <div className={`${cardClass} flex flex-wrap gap-4`}>
            <label className="grid gap-1 font-semibold">
              子供
              <select
                className={inputClass}
                value={selectedChild}
                onChange={(e) => setSelectedChild(e.target.value)}
              >
                {children.map((child) => (
                  <option key={child.id} value={child.id}>
                    {child.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 font-semibold">
              年
              <select
                className={inputClass}
                value={selectedYear}
                onChange={(e) => setSelectedYear(Number(e.target.value))}
              >
                {years.map((year) => (
                  <option key={year} value={year}>
                    {year}年
                  </option>
                ))}
              </select>
            </label>
          </div>
          {!loaded ? (
            <p className={cardClass}>読み込み中…</p>
          ) : (
            <>
              <div className={cardClass}>
                <p className="mb-4 text-lg font-bold">
                  {selectedYear}年 合計: <span className="text-green-600">{yearTotal}円</span>
                  <span className="ml-3 text-sm font-normal text-[#5C410E]/70">
                    (完了 {yearCount} 件)
                  </span>
                </p>
                <div className="flex items-end gap-2">
                  {months.map((m) => (
                    <div key={m.month} className="flex flex-1 flex-col items-center gap-1">
                      <div className="flex h-48 w-full items-end sm:h-64">
                        <div
                          className="w-full rounded-t-md bg-blue-500"
                          style={{ height: `${(m.reward / maxReward) * 100}%` }}
                          title={`${m.month}月: ${m.reward}円（${m.count}件）`}
                        />
                      </div>
                      <span className="text-xs text-[#5C410E]/70">{m.month}月</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className={`${cardClass} overflow-x-auto`}>
                <table className="w-full text-left text-sm sm:text-base">
                  <thead>
                    <tr className="border-b border-[#5C410E]/15">
                      <th className="py-2">月</th>
                      <th className="py-2">完了件数</th>
                      <th className="py-2">報酬合計</th>
                    </tr>
                  </thead>
                  <tbody>
                    {months.map((m) => (
                      <tr key={m.month} className="border-b border-[#5C410E]/10 last:border-0">
                        <td className="py-2">{m.month}月</td>
                        <td className="py-2">{m.count}件</td>
                        <td className="py-2 font-semibold text-green-600">{m.reward}円</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
      <Link className={linkClass} to="/top">
        親のトップへ
      </Link>
    </div>
  );
}
