import "./buffer-polyfill.ts";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./index.css";
import App from "./App";
import PublicFeed from "./PublicFeed";
import PublicProfile from "./PublicProfile";

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <Routes>
      {/* Public routes — no auth */}
      <Route path="/" element={<PublicFeed />} />
      <Route path="/p/:npub" element={<PublicProfile />} />
      {/* Authenticated app */}
      <Route path="/chat" element={<App />} />
    </Routes>
  </BrowserRouter>,
);
