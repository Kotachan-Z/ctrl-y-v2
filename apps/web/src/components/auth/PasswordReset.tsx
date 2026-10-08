import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { api, tokens } from "../../api";
import { linkClass } from "../../styles/shared";
import AuthLayout from "../common/AuthLayout";
import Field from "../common/Field";
import Form from "../common/Form";

export default function PasswordReset({ confirm = false }: { confirm?: boolean }) {
  const { token } = useParams();
  const [done, setDone] = useState(false);
  return (
    <AuthLayout>
      <h1>{confirm ? "パスワードの再設定" : "パスワードを忘れた場合"}</h1>
      {done ? (
        <p role="status">
          {confirm
            ? "パスワードを変更しました。新しいパスワードでログインしてください。"
            : "登録されている場合、再設定用リンクを送信しました。メールをご確認ください。"}
        </p>
      ) : (
        <Form
          label={confirm ? "パスワードを変更" : "再設定リンクを送信"}
          submit={async (data) => {
            if (confirm && data.get("password") !== data.get("confirmation"))
              throw new Error("パスワードが一致しません");
            await api(`/parents/password-reset/${confirm ? "confirm" : "request"}`, {
              body: confirm
                ? { token, password: data.get("password") }
                : { email: data.get("email") },
            });
            if (confirm) await tokens.remove("parent");
            setDone(true);
          }}
        >
          {confirm ? (
            <>
              <Field
                name="password"
                label="新しいパスワード"
                type="password"
                minLength={8}
                autoComplete="new-password"
              />
              <Field
                name="confirmation"
                label="新しいパスワード（確認）"
                type="password"
                minLength={8}
                autoComplete="new-password"
              />
              <p>8文字以上・UTF-8で72バイト以内。リンクの有効期限は15分です。</p>
            </>
          ) : (
            <Field name="email" label="メールアドレス" type="email" maxLength={254} />
          )}
        </Form>
      )}
      {confirm && (
        <Link className={linkClass} to="/forgot-password">
          リンクを再発行する
        </Link>
      )}
      <Link className={linkClass} to="/">
        親ログインへ
      </Link>
    </AuthLayout>
  );
}
