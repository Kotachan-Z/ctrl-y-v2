import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  api,
  ApiError,
  offlineEvent,
  syncEvent,
  pendingOperations,
  replayOfflineOperations,
  isOfflineQueueKey,
  type Role,
} from "../../api";
import {
  buttonClass,
  primaryButton,
  secondaryButton,
  neutralButton,
  cardClass,
} from "../../styles/shared";
import TaskEditor from "./TaskEditor";
import type { Task } from "./TaskEditor";

const taskLabels = {
  TODO: "これから",
  IN_PROGRESS: "進行中",
  WAIT_REVIEW: "確認待ち",
  DONE: "完了",
};

export default function TaskBoard({ role, childId }: { role: Role; childId?: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [pending, setPending] = useState<Awaited<ReturnType<typeof pendingOperations>>>([]);
  useEffect(() => {
    let active = true;
    let revision = 0;
    const updatePending = () => {
      const current = ++revision;
      void pendingOperations(role).then((operations) => {
        if (active && current === revision) setPending(operations);
      });
    };
    updatePending();
    const refresh = () => setVersion((v) => v + 1);
    const storage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || !isOfflineQueueKey(event.key)) return;
      updatePending();
      refresh();
    };
    window.addEventListener(offlineEvent, updatePending);
    window.addEventListener(syncEvent, refresh);
    window.addEventListener("storage", storage);
    return () => {
      active = false;
      window.removeEventListener(offlineEvent, updatePending);
      window.removeEventListener(syncEvent, refresh);
      window.removeEventListener("storage", storage);
    };
  }, [role]);
  const [tab, setTab] = useState<"list" | "create">("list");
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
      const result = await api<{ queued?: boolean }>(
        `/tasks/${task.id}${status ? "/status" : ""}`,
        {
          role,
          method: status ? "PATCH" : "DELETE",
          ...(status ? { body: { status } } : {}),
        },
      );
      if (!result.queued) setVersion((v) => v + 1);
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
        setTab("list");
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
          <div className="flex gap-2" role="tablist">
            <button
              role="tab"
              aria-selected={tab === "list"}
              className={`${buttonClass} ${tab === "list" ? primaryButton : "bg-white/70 text-[#5C410E] enabled:hover:bg-white"}`}
              onClick={() => setTab("list")}
            >
              タスク一覧
            </button>
            <button
              role="tab"
              aria-selected={tab === "create"}
              className={`${buttonClass} ${tab === "create" ? primaryButton : "bg-white/70 text-[#5C410E] enabled:hover:bg-white"}`}
              onClick={() => setTab("create")}
            >
              タスクを追加
            </button>
          </div>
        )}
        {role === "parent" && tab === "create" && (
          <section className={`${cardClass} mx-auto max-w-2xl`}>
            <h2 className="mb-5 text-2xl font-extrabold">タスクを追加</h2>
            <TaskEditor save={(data) => save(data)} />
          </section>
        )}
        {(role !== "parent" || tab === "list") && (
          <>
            <button
              className={secondaryButton}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await replayOfflineOperations();
                } catch (e) {
                  report(e);
                } finally {
                  setVersion((v) => v + 1);
                  setBusy(false);
                }
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
          </>
        )}
        {(role !== "parent" || tab === "list") &&
          Object.entries(taskLabels).map(([status, label]) => (
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
                              disabled={
                                busy ||
                                pending.some((entry) => entry.path === `/tasks/${task.id}/status`)
                              }
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
