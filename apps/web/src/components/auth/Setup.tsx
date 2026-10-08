import { Link, useNavigate } from "react-router-dom";

import { api } from "../../api";
import { linkClass } from "../../styles/shared";
import AuthLayout from "../common/AuthLayout";
import Field from "../common/Field";
import Form from "../common/Form";

export default function Setup() {
  const navigate = useNavigate();
  return (
    <AuthLayout>
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
        <p>家族の子供全員で共有します。4文字以上です。</p>
      </Form>
      <Link className={linkClass} to="/children">
        子供一覧へ
      </Link>
    </AuthLayout>
  );
}
