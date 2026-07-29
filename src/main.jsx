import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

const isTemporaryTunnel = [".pinggy-free.link", ".free.pinggy.net"].some((suffix) =>
  window.location.hostname.endsWith(suffix)
);

if ("serviceWorker" in navigator && isTemporaryTunnel) {
  // Free tunnel pages can inject an interstitial that must never become the app shell.
  window.addEventListener("load", () => {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      registrations.forEach((registration) => registration.unregister());
    });
  });
} else if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("Service worker registration failed:", error);
    });
  });
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
