import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router"
import { RootLayout } from "./routes/root.route"
import { IndexRoute, ProjectRoute } from "./routes/project.route"
import { SystemRoute } from "./routes/system.route"

// Code-based route tree — four routes do not justify a codegen plugin.

const rootRoute = createRootRoute({ component: RootLayout })

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: IndexRoute
})

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/project/$projectId",
  component: ProjectRoute
})

// Systems are addressed by their bare key — /system/engine — rather than the
// `sys:` id the stores use, which keeps a colon out of the URL bar.
const systemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/system/$systemId",
  component: SystemRoute
})

const routeTree = rootRoute.addChildren([indexRoute, projectRoute, systemRoute])

export const router = createRouter({ routeTree })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
