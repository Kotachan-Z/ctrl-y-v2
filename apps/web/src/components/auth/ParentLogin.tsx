import { Link, useNavigate } from "react-router-dom";

import { api, tokens } from "../../api";
import { linkClass } from "../../styles/shared";
import AuthLayout from "../common/AuthLayout";
import Field from "../common/Field";
import Form from "../common/Form";

export default function ParentLogin({ signup = false }: { signup?: boolean }) {
  const navigate = useNavigate();
  return (
    <AuthLayout>
      <h1>{signup ? "親アカウント登録" : "親ログイン"}</h1>
      <Form
        label={signup ? "登録する" : "ログイン"}
        submit={async (data) => {
          const result = await api<{ token: string; refreshToken: string; needsSetup: boolean }>(
            signup ? "/parents" : "/parents/login",
            { body: { email: data.get("email"), password: data.get("password") } },
          );
          tokens.set("parent", result.token, result.refreshToken);
          void navigate(result.needsSetup ? "/setup" : "/top", { replace: true });
        }}
      >
        <Field name="email" label="メールアドレス" type="email" maxLength={254} />
        <Field name="password" label="パスワード" type="password" minLength={8} />
        <p>パスワードは8文字以上です。</p>
      </Form>
      {!signup && (
        <Link className={linkClass} to="/forgot-password">
          パスワードを忘れた場合
        </Link>
      )}
      <Link className={linkClass} to={signup ? "/" : "/signup"}>
        {signup ? "ログインへ" : "新規登録へ"}
      </Link>
    </AuthLayout>
  );
}
