import { StrictMode, useEffect, useState, type FormEvent, type ReactNode } from "react";
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

import "./style.css";

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
    setBusy(true);
    setError("");
    try {
      await submit(new FormData(event.currentTarget));
    } catch (e) {
      setError(e instanceof Error ? e.message : "通信に失敗しました");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={handle}>
      {children}
      {error && <p role="alert">{error}</p>}
      <button disabled={busy}>{busy ? "送信中…" : label}</button>
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
    <label>
      {label}
      <input
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
    <>
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
        <p>パスワードは8文字以上、UTF-8で72バイト以内です。</p>
      </Form>
      <Link to={signup ? "/" : "/signup"}>{signup ? "ログインへ" : "新規登録へ"}</Link>
    </>
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
    return <p role="alert">接続できません。時間をおいて再読み込みしてください。</p>;
  if (status === "denied")
    return <Navigate to={role === "parent" ? "/" : `/child/login/${childId}`} replace />;
  return children;
}
function Setup() {
  const navigate = useNavigate();
  return (
    <>
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
        <p>家族の子供全員で共有します。4文字以上、UTF-8で72バイト以内です。</p>
      </Form>
      <Link to="/children">子供一覧へ</Link>
    </>
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
    <>
      <h1>子供のログインURL</h1>
      <p>URLとあいことばを子供に共有してください。</p>
      {message && <p role="status">{message}</p>}
      {children.map((child) => {
        const url = `${window.location.origin}/child/login/${child.id}`;
        return (
          <section key={child.id}>
            <h2>{child.name}</h2>
            <a href={url}>{url}</a>
            <button
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
          <Link to="/setup">初回セットアップへ</Link>
        ))}
      <Link to="/top">親のトップへ</Link>
    </>
  );
}
function ChildLogin() {
  const { childId } = useParams();
  const navigate = useNavigate();
  return (
    <>
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
      <Link to="/">親ログインへ</Link>
    </>
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
    <Form label={task ? "保存する" : "タスクを作成"} submit={save}>
      <label>
        タスク名
        <input name="name" required maxLength={100} defaultValue={task?.name} />
      </label>
      <label>
        メモ
        <textarea name="memo" maxLength={2000} defaultValue={task?.memo ?? ""} />
      </label>
      <label>
        報酬（円）
        <input
          name="reward"
          type="number"
          required
          min={0}
          max={2147483647}
          step={1}
          defaultValue={task?.reward ?? 0}
        />
      </label>
      <label>
        期限
        <input name="deadline" type="datetime-local" required defaultValue={localDeadline} />
      </label>
    </Form>
  );
}
function TaskBoard({ role, childId }: { role: Role; childId?: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
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
      setEditing(null);
      setVersion((v) => v + 1);
    } catch (e) {
      report(e);
      throw e;
    }
  }
  return (
    <>
      {role === "parent" && (
        <section>
          <h2>タスクを追加</h2>
          <TaskEditor save={(data) => save(data)} />
        </section>
      )}
      <button
        disabled={busy}
        onClick={() => {
          setError("");
          setVersion((v) => v + 1);
        }}
      >
        一覧を更新
      </button>
      {error && <p role="alert">{error}</p>}
      {!loaded && <p>読み込み中…</p>}
      {Object.entries(taskLabels).map(([status, label]) => (
        <section key={status} aria-label={label}>
          <h2>{label}</h2>
          {loaded && !tasks.some((task) => task.status === status) && <p>タスクはありません</p>}
          {tasks
            .filter((task) => task.status === status)
            .map((task) => (
              <article key={task.id} aria-label={task.name}>
                <h3>{task.name}</h3>
                <p>{task.memo}</p>
                <p>
                  報酬: {task.reward}円 / 期限: {new Date(task.deadline).toLocaleString()}
                </p>
                {role === "child" && task.childId === childId && <p>あなたの担当</p>}
                {role === "parent" ? (
                  <>
                    {status === "WAIT_REVIEW" && (
                      <button disabled={busy} onClick={() => mutate(task, "DONE")}>
                        承認
                      </button>
                    )}
                    <button disabled={busy} onClick={() => setEditing(task.id)}>
                      編集
                    </button>
                    <button disabled={busy} onClick={() => mutate(task)}>
                      削除
                    </button>
                    {editing === task.id && (
                      <>
                        <TaskEditor task={task} save={(data) => save(data, task)} />
                        <button onClick={() => setEditing(null)}>キャンセル</button>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    {status === "TODO" && task.childId === null && (
                      <button disabled={busy} onClick={() => mutate(task, "IN_PROGRESS")}>
                        はじめる
                      </button>
                    )}
                    {status === "IN_PROGRESS" && task.childId === childId && (
                      <button disabled={busy} onClick={() => mutate(task, "WAIT_REVIEW")}>
                        できた!
                      </button>
                    )}
                    {status === "WAIT_REVIEW" && <button disabled>まってね</button>}
                  </>
                )}
              </article>
            ))}
        </section>
      ))}
    </>
  );
}

function Top({ role }: { role: Role }) {
  const navigate = useNavigate();
  const { childId } = useParams();
  return (
    <>
      <h1>{role === "parent" ? "親のトップ" : "子供のトップ"}</h1>
      <TaskBoard role={role} childId={childId} />
      {role === "parent" && <Link to="/children">子供のログインURL・追加</Link>}
      <button
        onClick={() => {
          tokens.remove(role);
          void navigate(role === "parent" ? "/" : `/child/login/${childId}`, { replace: true });
        }}
      >
        ログアウト
      </button>
    </>
  );
}
function App() {
  return (
    <main>
      <p>Ctrl-Y v2 · ご褒美ポケット</p>
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
            <>
              <h1>ページが見つかりません</h1>
              <Link to="/">親ログインへ</Link>
            </>
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
