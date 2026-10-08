import { Link, useNavigate, useParams } from "react-router-dom";

import { api, tokens } from "../../api";
import { linkClass } from "../../styles/shared";
import AuthLayout from "../common/AuthLayout";
import Field from "../common/Field";
import Form from "../common/Form";

export default function ChildLogin() {
  const { childId } = useParams();
  const navigate = useNavigate();
  return (
    <AuthLayout>
      <h1>子供ログイン</h1>
      <Form
        label="ログイン"
        submit={async (data) => {
          const { token, refreshToken } = await api<{ token: string; refreshToken: string }>(
            `/children/${childId}/login`,
            {
              body: { keyword: data.get("keyword") },
            },
          );
          tokens.set("child", token, refreshToken);
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
