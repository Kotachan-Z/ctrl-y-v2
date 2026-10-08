import { useState, type FormEvent, type ReactNode } from "react";

import { primaryButton } from "../../styles/shared";

export default function Form({
  children,
  submit,
  label,
}: {
  children: ReactNode;
  submit: (data: FormData) => Promise<void>;
  label: string;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function handle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setError("");
    try {
      await submit(new FormData(form));
      form.reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : "通信に失敗しました");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={handle} className="grid min-w-0 gap-5 [&>p]:text-sm [&>p]:leading-relaxed">
      {children}
      {error && (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-red-800" role="alert">
          {error}
        </p>
      )}
      <button className={`${primaryButton} mx-auto mt-2 min-w-44`} disabled={busy}>
        {busy ? "送信中…" : label}
      </button>
    </form>
  );
}
