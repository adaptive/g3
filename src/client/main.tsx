import { render } from "solid-js/web";
import { App } from "./App";
import "./styles.css";

if ("serviceWorker" in navigator && window.isSecureContext) {
  void navigator.serviceWorker.register("/gallery-sw.js", { scope: "/" }).catch(() => {});
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
render(() => <App />, root);
