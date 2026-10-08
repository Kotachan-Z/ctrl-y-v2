import { useNavigate, useParams } from "react-router-dom";

import { logout, type Role } from "../../api";
import { neutralButton } from "../../styles/shared";
import LinkCard from "../common/LinkCard";
import TaskBoard from "../tasks/TaskBoard";

export default function Top({ role }: { role: Role }) {
  const navigate = useNavigate();
  const { childId } = useParams();
  return (
    <div className="mx-auto max-w-6xl space-y-6 py-6 sm:py-10">
      <h1 className="text-center text-3xl font-extrabold sm:text-4xl">
        {role === "parent" ? "親のトップ" : "子供のトップ"}
      </h1>
      <TaskBoard role={role} childId={childId} />
      {role === "parent" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <LinkCard
            to="/children"
            icon="/images/icon-children.png"
            title="子供のログインURL"
            description="共有・追加はこちらから"
          />
          <LinkCard
            to="/records"
            icon="/images/icon-money.png"
            title="給与記録"
            description="月ごとの支払い実績を確認"
          />
          <LinkCard
            to="/settings"
            icon="/images/icon-account.png"
            title="設定"
            description="給与・通知・アカウントなどの設定"
          />
        </div>
      )}
      <button
        className={neutralButton}
        onClick={() => {
          void logout(role)
            .then(() => {
              void navigate(role === "parent" ? "/" : `/child/login/${childId}`, { replace: true });
            })
            .catch(() => {
              window.alert("ログアウトに失敗しました。通信を確認して再試行してください。");
            });
        }}
      >
        ログアウト
      </button>
    </div>
  );
}
