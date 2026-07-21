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

const host = document.getElementById("root")
if (host === null) throw new Error("#root missing")

createRoot(host).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
)
