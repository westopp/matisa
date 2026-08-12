import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RouterProvider } from "@tanstack/react-router"
// The collapsible's grid/@starting-style animation lives in its own stylesheet;
// imported before ours so app rules win on any shared selector.
import "@westopp/react-collapsible/styles.css"
import "./styles.css"
import "./store/store.ui"
import "./store/store.engine"
import { router } from "./router"
import { inShell } from "./lib/native"

// Inside the Electron shell the OS draws the real traffic lights over our
// titlebar strip — CSS keyed off this attribute hides the mock ones and makes
// the strip draggable.
if (inShell()) document.documentElement.setAttribute("data-shell", "electron")

const host = document.getElementById("root")
if (host === null) throw new Error("#root missing")

createRoot(host).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
)
