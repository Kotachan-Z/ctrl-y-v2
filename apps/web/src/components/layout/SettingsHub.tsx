import { Link } from "react-router-dom";

import { linkClass } from "../../styles/shared";
import LinkCard from "../common/LinkCard";

export default function SettingsHub() {
  return (
    <div className="mx-auto max-w-xl space-y-6 py-6 sm:py-10">
      <h1 className="text-center text-3xl font-extrabold sm:text-4xl">設定</h1>
      <div className="grid gap-4 sm:grid-cols-2">
        <LinkCard
          to="/settings/payroll"
          icon="/images/icon-money.png"
          title="給与設定"
          description="給料日・締め日を変更"
        />
        <LinkCard
          to="/settings/notifications"
          icon="/images/icon-notice.png"
          title="通知設定"
          description="タスク完了通知のON/OFFを切り替え"
        />
      </div>
      <Link className={linkClass} to="/top">
        親のトップへ
      </Link>
    </div>
  );
}
