import { Link, Route, Routes } from "react-router-dom";

import ChildLogin from "./components/auth/ChildLogin";
import ParentLogin from "./components/auth/ParentLogin";
import PasswordReset from "./components/auth/PasswordReset";
import Setup from "./components/auth/Setup";
import Children from "./components/children/Children";
import AuthLayout from "./components/common/AuthLayout";
import Guard from "./components/common/Guard";
import OfflineStatus from "./components/layout/OfflineStatus";
import SettingsHub from "./components/layout/SettingsHub";
import Top from "./components/layout/Top";
import NotificationSettings from "./components/notifications/NotificationSettings";
import SalaryRecords from "./components/salary/SalaryRecords";
import SalarySettings from "./components/salary/SalarySettings";
import { linkClass } from "./styles/shared";

export default function App() {
  return (
    <main className="min-h-svh bg-[#FFF877] bg-[url('/images/back2.png')] bg-cover bg-fixed bg-center bg-no-repeat px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] font-sans text-[#5C410E] md:bg-[url('/images/back.png')] sm:px-8">
      <p className="text-center text-sm font-bold tracking-wide">Ctrl-Y v2 · ご褒美ポケット</p>
      <OfflineStatus />
      <Routes>
        <Route path="/" element={<ParentLogin />} />
        <Route path="/forgot-password" element={<PasswordReset key="request" />} />
        <Route path="/reset-password/:token" element={<PasswordReset key="confirm" confirm />} />
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
        <Route
          path="/records"
          element={
            <Guard role="parent">
              <SalaryRecords />
            </Guard>
          }
        />
        <Route
          path="/settings"
          element={
            <Guard role="parent">
              <SettingsHub />
            </Guard>
          }
        />
        <Route
          path="/settings/payroll"
          element={
            <Guard role="parent">
              <SalarySettings />
            </Guard>
          }
        />
        <Route
          path="/settings/notifications"
          element={
            <Guard role="parent">
              <NotificationSettings />
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
