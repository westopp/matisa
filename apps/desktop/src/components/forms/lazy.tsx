import { lazy, Suspense, type ComponentProps } from "react"

// Dialogs are the only consumers of the form builder, and none of them is on
// the first-paint path — so they load on open, not on boot (CPERF-200). The
// fallback is empty on purpose: the chunk is local and resolves within a frame,
// and a spinner that flashes for 16ms is worse than nothing.

const AddProject = lazy(() =>
  import("./project.form").then((m) => ({ default: m.AddProjectDialog }))
)
const EditProject = lazy(() =>
  import("./project.form").then((m) => ({ default: m.EditProjectDialog }))
)
const SetEnvVar = lazy(() => import("./env.form").then((m) => ({ default: m.SetEnvVarDialog })))
const SetCommand = lazy(() => import("./command.form").then((m) => ({ default: m.SetCommandDialog })))
const Group = lazy(() => import("./group.form").then((m) => ({ default: m.GroupDialog })))

export const AddProjectDialog = (props: ComponentProps<typeof AddProject>) => (
  <Suspense fallback={null}>
    <AddProject {...props} />
  </Suspense>
)

export const EditProjectDialog = (props: ComponentProps<typeof EditProject>) => (
  <Suspense fallback={null}>
    <EditProject {...props} />
  </Suspense>
)

export const SetEnvVarDialog = (props: ComponentProps<typeof SetEnvVar>) => (
  <Suspense fallback={null}>
    <SetEnvVar {...props} />
  </Suspense>
)

export const SetCommandDialog = (props: ComponentProps<typeof SetCommand>) => (
  <Suspense fallback={null}>
    <SetCommand {...props} />
  </Suspense>
)

export const GroupDialog = (props: ComponentProps<typeof Group>) => (
  <Suspense fallback={null}>
    <Group {...props} />
  </Suspense>
)

