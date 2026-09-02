import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.tsx";
import { Toaster } from "./components/ui/sonner.tsx";
import "./styles.css";

const media = window.matchMedia("(prefers-color-scheme: dark)");
const applyColorScheme = () => document.documentElement.classList.toggle("dark", media.matches);
applyColorScheme();
media.addEventListener("change", applyColorScheme);

// Page zoom changes devicePixelRatio; re-arm a one-shot media query each time
// so the native traffic lights get re-centered against the scaled header.
const watchZoom = () => {
  const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  query.addEventListener(
    "change",
    () => {
      window.remoteAgent.window?.syncTrafficLights();
      watchZoom();
    },
    { once: true },
  );
};
watchZoom();
window.remoteAgent.window?.syncTrafficLights();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    <Toaster />
  </React.StrictMode>,
);
