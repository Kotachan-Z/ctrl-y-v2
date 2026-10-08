import { inputClass } from "../../styles/shared";
import Form from "../common/Form";

export type Task = {
  id: string;
  name: string;
  memo: string | null;
  reward: number;
  deadline: string;
  childId: string | null;
  status: "TODO" | "IN_PROGRESS" | "WAIT_REVIEW" | "DONE";
};

export default function TaskEditor({
  task,
  save,
}: {
  task?: Task;
  save: (data: FormData) => Promise<void>;
}) {
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
