import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./style.css";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main>
      <p>ご褒美ポケット</p>
      <h1>Ctrl-Y v2 — Coming soon</h1>
      <p>親子で楽しむタスクとご褒美。準備中です。</p>
    </main>
  </StrictMode>,
);
