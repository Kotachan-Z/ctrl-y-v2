import { Link } from "react-router-dom";

import { linkClass } from "../../styles/shared";
import PushNotifications from "./PushNotifications";

export default function NotificationSettings() {
  return (
    <div className="mx-auto max-w-xl space-y-6 py-6 sm:py-10">
      <h1 className="text-center text-3xl font-extrabold sm:text-4xl">通知設定</h1>
      <PushNotifications />
      <Link className={linkClass} to="/settings">
        設定へ戻る
      </Link>
    </div>
  );
}
