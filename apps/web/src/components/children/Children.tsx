import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api, ApiError, type Child } from "../../api";
import { secondaryButton, inputClass, linkClass, cardClass } from "../../styles/shared";
import AuthLayout from "../common/AuthLayout";
import Field from "../common/Field";
import Form from "../common/Form";

export default function Children() {
  const [children, setChildren] = useState<Child[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const navigate = useNavigate();
  useEffect(() => {
    let active = true;
    api<{ children: Child[] }>("/children", { role: "parent" })
      .then((result) => {
        if (active) {
          setChildren(result.children);
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
  }, [navigate]);
  return (
    <AuthLayout>
      <h1>子供のログインURL</h1>
      <p>URLとあいことばを子供に共有してください。</p>
      {message && (
        <p className="rounded-lg bg-blue-50 px-4 py-3 text-blue-900" role="status">
          {message}
        </p>
      )}
      {children.map((child) => {
        const url = `${window.location.origin}/child/login/${child.id}`;
        return (
          <section key={child.id} className={`${cardClass} grid gap-4 sm:grid-cols-[1fr_auto]`}>
            <h2 className="text-xl font-bold sm:col-span-2">{child.name}</h2>
            <a className={`${inputClass} ${linkClass} self-center wrap-anywhere`} href={url}>
              {url}
            </a>
            <button
              className={secondaryButton}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(url);
                  setMessage("URLをコピーしました");
                } catch {
                  setMessage("コピーできませんでした。表示されたURLを選択してコピーしてください。");
                }
              }}
            >
              URLをコピー
            </button>
          </section>
        );
      })}
      {loaded &&
        (children.length ? (
          <>
            <h2>子供を追加</h2>
            <Form
              label="追加する"
              submit={async (data) => {
                const { child } = await api<{ child: Child }>("/children", {
                  role: "parent",
                  body: { name: data.get("name") },
                });
                setChildren((current) => [...current, child]);
              }}
            >
              <Field name="name" label="子供の名前" maxLength={50} />
            </Form>
          </>
        ) : (
          <Link className={linkClass} to="/setup">
            初回セットアップへ
          </Link>
        ))}
      <Link className={linkClass} to="/top">
        親のトップへ
      </Link>
    </AuthLayout>
  );
}
