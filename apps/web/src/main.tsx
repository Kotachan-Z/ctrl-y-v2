import { StrictMode, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router-dom";

import { api, ApiError, tokens, type Child, type Identity, type Role } from "./api";
import { registerServiceWorker, urlBase64ToUint8Array } from "./push";

import "./style.css";

const buttonClass =
  "inline-flex min-h-11 items-center justify-center rounded-lg px-5 py-2.5 font-bold shadow-sm transition-colors duration-300 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50 enabled:cursor-pointer";
const primaryButton = `${buttonClass} bg-blue-500 text-white enabled:hover:bg-blue-600`;
const secondaryButton = `${buttonClass} bg-orange-300 text-[#5C410E] enabled:hover:bg-orange-400`;
const neutralButton = `${buttonClass} bg-gray-200 text-[#5C410E] enabled:hover:bg-gray-300`;
const inputClass =
  "min-w-0 w-full rounded-lg border border-[#5C410E]/30 bg-gray-100 px-4 py-3 text-base font-normal text-gray-900 outline-none transition-shadow focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30";
const linkClass =
  "inline-block rounded-sm font-medium text-blue-700 underline underline-offset-4 transition-colors hover:text-blue-500 focus-visible:outline-2 focus-visible:outline-offset-4";
const cardClass = "rounded-lg border border-[#5C410E]/15 bg-gray-50 p-5 shadow-lg sm:p-7";

function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[calc(100svh-5rem)] w-full max-w-xl flex-col justify-center gap-6 py-8 sm:gap-8 [&>h1]:text-center [&>h1]:text-3xl [&>h1]:font-extrabold sm:[&>h1]:text-4xl [&>h2]:text-2xl [&>h2]:font-bold [&>a]:self-center">
      <img
        src="/images/180icon.png"
        alt="ご褒美ポケットのマスコット"
        width="180"
        height="180"
        className="mx-auto h-32 w-32 object-contain sm:h-40 sm:w-40"
      />
      {children}
    </div>
  );
}

function Form({
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
function Field({
  name,
  label,
  type = "text",
  minLength,
  maxLength,
}: {
  name: string;
  label: string;
  type?: string;
  minLength?: number;
  maxLength?: number;
}) {
  return (
    <label className="grid min-w-0 gap-2 font-semibold">
      {label}
      <input
        className={inputClass}
        name={name}
        type={type}
        required
        minLength={minLength}
        maxLength={maxLength}
        autoComplete={name === "email" ? "email" : name === "password" ? "current-password" : "off"}
      />
    </label>
  );
}
function ParentLogin({ signup = false }: { signup?: boolean }) {
  const navigate = useNavigate();
  return (
    <AuthLayout>
      <h1>{signup ? "親アカウント登録" : "親ログイン"}</h1>
      <Form
        label={signup ? "登録する" : "ログイン"}
        submit={async (data) => {
          const result = await api<{ token: string; needsSetup: boolean }>(
            signup ? "/parents" : "/parents/login",
            { body: { email: data.get("email"), password: data.get("password") } },
          );
          tokens.set("parent", result.token);
          void navigate(result.needsSetup ? "/setup" : "/top", { replace: true });
        }}
      >
        <Field name="email" label="メールアドレス" type="email" maxLength={254} />
        <Field name="password" label="パスワード" type="password" minLength={8} />
        <p>パスワードは8文字以上です。</p>
      </Form>
      <Link className={linkClass} to={signup ? "/" : "/signup"}>
        {signup ? "ログインへ" : "新規登録へ"}
      </Link>
    </AuthLayout>
  );
}
function Guard({ role, children }: { role: Role; children: ReactNode }) {
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
function Setup() {
  const navigate = useNavigate();
  return (
    <AuthLayout>
      <h1>初回セットアップ</h1>
      <Form
        label="子供を作成する"
        submit={async (data) => {
          await api("/setup", {
            role: "parent",
            body: { name: data.get("name"), keyword: data.get("keyword") },
          });
          void navigate("/children", { replace: true });
        }}
      >
        <Field name="name" label="子供の名前" maxLength={50} />
        <Field name="keyword" label="あいことば" type="password" minLength={4} />
        <p>家族の子供全員で共有します。4文字以上です。</p>
      </Form>
      <Link className={linkClass} to="/children">
        子供一覧へ
      </Link>
    </AuthLayout>
  );
}
function Children() {
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
function ChildLogin() {
  const { childId } = useParams();
  const navigate = useNavigate();
  return (
    <AuthLayout>
      <h1>子供ログイン</h1>
      <Form
        label="ログイン"
        submit={async (data) => {
          const { token } = await api<{ token: string }>(`/children/${childId}/login`, {
            body: { keyword: data.get("keyword") },
          });
          tokens.set("child", token);
          void navigate(`/child/top/${childId}`, { replace: true });
        }}
      >
        <Field name="keyword" label="あいことば" type="password" minLength={4} />
      </Form>
      <Link className={linkClass} to="/">
        親ログインへ
      </Link>
    </AuthLayout>
  );
}
type Task = {
  id: string;
  name: string;
  memo: string | null;
  reward: number;
  deadline: string;
  childId: string | null;
  status: "TODO" | "IN_PROGRESS" | "WAIT_REVIEW" | "DONE";
};
const taskLabels = {
  TODO: "これから",
  IN_PROGRESS: "進行中",
  WAIT_REVIEW: "確認待ち",
  DONE: "完了",
};
function TaskEditor({ task, save }: { task?: Task; save: (data: FormData) => Promise<void> }) {
  const localDeadline = task
    ? new Date(
        new Date(task.deadline).getTime() - new Date(task.deadline).getTimezoneOffset() * 60000,
      )
        .toISOString()
        .slice(0, 16)
    : "";
  return (
    <div className="[&>form>button]:bg-orange-300 [&>form>button]:text-[#5C410E] [&>form>button:enabled:hover]:bg-orange-400">
      <Form label={task ? "保存する" : "タスクを作成"} submit={save}>
        <label className="grid min-w-0 gap-2 font-semibold">
          タスク名
          <input
            className={inputClass}
            name="name"
            required
            maxLength={100}
            defaultValue={task?.name}
          />
        </label>
        <label className="grid min-w-0 gap-2 font-semibold">
          メモ
          <textarea
            className={`${inputClass} min-h-24 resize-y`}
            name="memo"
            maxLength={2000}
            defaultValue={task?.memo ?? ""}
          />
        </label>
        <label className="grid min-w-0 gap-2 font-semibold">
          報酬（円）
          <input
            className={inputClass}
            name="reward"
            type="number"
            required
            min={0}
            max={1000000}
            step={1}
            defaultValue={task?.reward ?? 0}
          />
        </label>
        <label className="grid min-w-0 gap-2 font-semibold">
          期限
          <input
            className={inputClass}
            name="deadline"
            type="datetime-local"
            required
            defaultValue={localDeadline}
          />
        </label>
      </Form>
    </div>
  );
}
function TaskBoard({ role, childId }: { role: Role; childId?: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const boardRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  function report(e: unknown) {
    setError(e instanceof Error ? e.message : "通信に失敗しました");
    if (e instanceof ApiError && e.status === 401)
      void navigate(role === "parent" ? "/" : `/child/login/${childId}`, { replace: true });
  }
  useEffect(() => {
    let active = true;
    api<{ tasks: Task[] }>("/tasks", { role })
      .then((result) => {
        if (active) {
          setTasks(result.tasks);
          setLoaded(true);
        }
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : "通信に失敗しました");
      });
    return () => {
      active = false;
    };
  }, [role, version]);
  async function mutate(task: Task, status?: Task["status"]) {
    if (!status && !window.confirm(`「${task.name}」を削除しますか？`)) return;
    setBusy(true);
    setError("");
    try {
      await api(`/tasks/${task.id}${status ? "/status" : ""}`, {
        role,
        method: status ? "PATCH" : "DELETE",
        ...(status ? { body: { status } } : {}),
      });
      setVersion((v) => v + 1);
    } catch (e) {
      report(e);
      setVersion((v) => v + 1);
    } finally {
      setBusy(false);
    }
  }
  async function save(data: FormData, task?: Task) {
    try {
      const deadline = data.get("deadline");
      if (typeof deadline !== "string") throw new Error("期限を入力してください");
      await api(task ? `/tasks/${task.id}` : "/tasks", {
        role,
        method: task ? "PATCH" : "POST",
        body: {
          name: data.get("name"),
          memo: data.get("memo"),
          reward: Number(data.get("reward")),
          deadline: new Date(deadline).toISOString(),
        },
      });
      if (!task) {
        // Runs after the caller's form.reset(), which can itself nudge scroll position.
        requestAnimationFrame(() => boardRef.current?.scrollTo({ top: 0 }));
      }
      setEditing(null);
      setVersion((v) => v + 1);
    } catch (e) {
      report(e);
      throw e;
    }
  }
  return (
    <div className="rounded-xl bg-[url('/images/mobile_note.png')] bg-size-[100%_100%] bg-center bg-no-repeat px-6 pt-16 pb-14 sm:px-10 md:bg-[url('/images/kokuban.png')] md:px-16 md:pt-12 md:pb-24">
      <div ref={boardRef} className="max-h-[34rem] space-y-6 overflow-y-auto pr-1 sm:max-h-[38rem]">
        {role === "parent" && (
          <section className={`${cardClass} mx-auto max-w-2xl`}>
            <h2 className="mb-5 text-2xl font-extrabold">タスクを追加</h2>
            <TaskEditor save={(data) => save(data)} />
          </section>
        )}
        <button
          className={secondaryButton}
          disabled={busy}
          onClick={() => {
            setError("");
            setVersion((v) => v + 1);
          }}
        >
          一覧を更新
        </button>
        {error && (
          <p className="rounded-lg bg-red-50 px-4 py-3 text-red-800" role="alert">
            {error}
          </p>
        )}
        {!loaded && <p className="rounded-lg bg-gray-50/95 p-4">読み込み中…</p>}
        {Object.entries(taskLabels).map(([status, label]) => (
          <section key={status} aria-label={label} className="space-y-4">
            <h2 className="inline-block rounded-lg bg-orange-100 px-5 py-2 text-xl font-extrabold shadow-sm sm:text-2xl">
              {label}
            </h2>
            {loaded && !tasks.some((task) => task.status === status) && (
              <p className="rounded-lg bg-gray-50/95 p-4 text-center text-[#5C410E]/75">
                タスクはありません
              </p>
            )}
            <div className="space-y-4">
              {tasks
                .filter((task) => task.status === status)
                .map((task) => (
                  <article
                    key={task.id}
                    aria-label={task.name}
                    className={`${cardClass} space-y-4 wrap-anywhere [&>button]:mr-3 [&>button]:mb-2`}
                  >
                    <h3 className="text-xl font-extrabold sm:text-2xl">{task.name}</h3>
                    <p className="whitespace-pre-wrap leading-relaxed">{task.memo}</p>
                    <p>
                      報酬:{" "}
                      <span className="text-xl font-bold text-green-600">{task.reward}円</span> /
                      期限: {new Date(task.deadline).toLocaleString()}
                    </p>
                    {role === "child" && task.childId === childId && <p>あなたの担当</p>}
                    {role === "parent" ? (
                      <>
                        {status === "WAIT_REVIEW" && (
                          <button
                            className={`${buttonClass} bg-green-400 text-[#5C410E] enabled:hover:bg-green-500`}
                            disabled={busy}
                            onClick={() => mutate(task, "DONE")}
                          >
                            承認
                          </button>
                        )}
                        <button
                          className={secondaryButton}
                          disabled={busy}
                          onClick={() => setEditing(task.id)}
                        >
                          編集
                        </button>
                        <button
                          className={neutralButton}
                          disabled={busy}
                          onClick={() => mutate(task)}
                        >
                          削除
                        </button>
                        {editing === task.id && (
                          <>
                            <TaskEditor task={task} save={(data) => save(data, task)} />
                            <button className={neutralButton} onClick={() => setEditing(null)}>
                              キャンセル
                            </button>
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        {status === "TODO" && task.childId === null && (
                          <button
                            className={primaryButton}
                            disabled={busy}
                            onClick={() => mutate(task, "IN_PROGRESS")}
                          >
                            はじめる
                          </button>
                        )}
                        {status === "IN_PROGRESS" && task.childId === childId && (
                          <button
                            className={primaryButton}
                            disabled={busy}
                            onClick={() => mutate(task, "WAIT_REVIEW")}
                          >
                            できた!
                          </button>
                        )}
                        {status === "WAIT_REVIEW" && (
                          <button className={neutralButton} disabled>
                            まってね
                          </button>
                        )}
                      </>
                    )}
                  </article>
                ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function PushNotifications() {
  const supported =
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(supported);
  const [message, setMessage] = useState(supported ? "" : "この環境では通知を利用できません");
  useEffect(() => {
    if (!supported) return;
    let active = true;
    registerServiceWorker()
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => {
        if (active) setEnabled(subscription !== null);
      })
      .catch(() => {
        if (active) setMessage("通知の設定を確認できませんでした");
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [supported]);
  async function toggle() {
    setBusy(true);
    setMessage("");
    try {
      if (!enabled && (await Notification.requestPermission()) !== "granted") {
        setMessage("通知が許可されていません。ブラウザの設定を確認してください");
        return;
      }
      const registration = await registerServiceWorker();
      const subscription = await registration.pushManager.getSubscription();
      if (enabled) {
        if (subscription) await subscription.unsubscribe();
        await api("/parents/push-subscription", { role: "parent", method: "DELETE" });
        setEnabled(false);
        setMessage("通知を無効にしました");
      } else {
        const { publicKey } = await api<{ publicKey: string }>("/push/public-key");
        const next =
          subscription ??
          (await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
          }));
        try {
          await api("/parents/push-subscription", {
            role: "parent",
            method: "PUT",
            body: next.toJSON(),
          });
        } catch (e) {
          if (!subscription) await next.unsubscribe();
          throw e;
        }
        setEnabled(true);
        setMessage("通知を有効にしました");
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "通知の設定に失敗しました");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={`${cardClass} space-y-4`}>
      <h2 className="text-xl font-bold">通知</h2>
      <button className={primaryButton} disabled={!supported || busy} onClick={toggle}>
        {busy ? "確認中…" : enabled ? "通知を無効にする" : "通知を有効にする"}
      </button>
      {message && (
        <p className="rounded-lg bg-blue-50 px-4 py-3 text-blue-900" role="status">
          {message}
        </p>
      )}
    </section>
  );
}

function Top({ role }: { role: Role }) {
  const navigate = useNavigate();
  const { childId } = useParams();
  return (
    <div className="mx-auto max-w-6xl space-y-6 py-6 sm:py-10">
      <h1 className="text-center text-3xl font-extrabold sm:text-4xl">
        {role === "parent" ? "親のトップ" : "子供のトップ"}
      </h1>
      {role === "parent" && <PushNotifications />}
      <TaskBoard role={role} childId={childId} />
      {role === "parent" && (
        <div className={cardClass}>
          <Link className={linkClass} to="/children">
            子供のログインURL・追加
          </Link>
        </div>
      )}
      <button
        className={neutralButton}
        onClick={() => {
          tokens.remove(role);
          void navigate(role === "parent" ? "/" : `/child/login/${childId}`, { replace: true });
        }}
      >
        ログアウト
      </button>
    </div>
  );
}
function App() {
  return (
    <main className="min-h-svh bg-[#FFF877] bg-[url('/images/back2.png')] bg-cover bg-fixed bg-center bg-no-repeat px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] font-sans text-[#5C410E] md:bg-[url('/images/back.png')] sm:px-8">
      <p className="text-center text-sm font-bold tracking-wide">Ctrl-Y v2 · ご褒美ポケット</p>
      <Routes>
        <Route path="/" element={<ParentLogin />} />
        <Route path="/signup" element={<ParentLogin signup />} />
        <Route
          path="/setup"
          element={
            <Guard role="parent">
              <Setup />
            </Guard>
          }
        />
        <Route
          path="/children"
          element={
            <Guard role="parent">
              <Children />
            </Guard>
          }
        />
        <Route
          path="/top"
          element={
            <Guard role="parent">
              <Top role="parent" />
            </Guard>
          }
        />
        <Route path="/child/login/:childId" element={<ChildLogin />} />
        <Route
          path="/child/top/:childId"
          element={
            <Guard role="child">
              <Top role="child" />
            </Guard>
          }
        />
        <Route
          path="*"
          element={
            <AuthLayout>
              <h1>ページが見つかりません</h1>
              <Link className={linkClass} to="/">
                親ログインへ
              </Link>
            </AuthLayout>
          }
        />
      </Routes>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
