import { create } from "zustand"

// Chrome-level UI state. Kept out of the engine store so a re-render caused by
// an event never fights with a theme flip, and so the terminals can subscribe
// to the theme without reaching into the DOM.

export type Theme = "dark" | "light"

/** The right drawer's tabs. The drawer is an overlay, not a column: it costs the
 *  content no width, so what lives in it can be consulted mid-task and dismissed
 *  without the layout moving underneath. */
export type DrawerTab = "failures" | "activity" | "resources" | "logs"

interface UiState {
  theme: Theme
  /** The left pane. The centre pane's collapse is the URL — there is no project
   *  in it — and the right pane's is `drawerOpen`, so this is the only one of
   *  the three that needs a flag of its own. */
  fleetCollapsed: boolean
  drawerOpen: boolean
  drawerTab: DrawerTab
  /** Narrow the drawer to the project in the URL. Off = the whole network. */
  drawerScoped: boolean
  toggleTheme: () => void
  toggleFleet: () => void
  collapseFleet: () => void
  toggleDrawer: () => void
  closeDrawer: () => void
  /** Opens the drawer on that tab — clicking a tab you cannot see is not a thing
   *  a caller should have to sequence. */
  openDrawer: (tab: DrawerTab) => void
  setDrawerTab: (tab: DrawerTab) => void
  setDrawerScoped: (scoped: boolean) => void
}

const stored = (): Theme => (localStorage.getItem("matisa.theme") === "light" ? "light" : "dark")

const storedTab = (): DrawerTab => {
  const raw = localStorage.getItem("matisa.drawerTab")
  return raw === "activity" || raw === "resources" || raw === "logs" ? raw : "failures"
}

const rememberTab = (tab: DrawerTab): DrawerTab => {
  localStorage.setItem("matisa.drawerTab", tab)
  return tab
}

export const useUi = create<UiState>()((set) => ({
  theme: stored(),
  fleetCollapsed: false,
  drawerOpen: false,
  drawerTab: storedTab(),
  drawerScoped: true,
  toggleTheme: () =>
    set((s) => {
      const theme: Theme = s.theme === "dark" ? "light" : "dark"
      localStorage.setItem("matisa.theme", theme)
      document.documentElement.setAttribute("data-theme", theme)
      return { theme }
    }),
  toggleFleet: () => set((s) => ({ fleetCollapsed: !s.fleetCollapsed })),
  collapseFleet: () => set({ fleetCollapsed: true }),
  toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
  closeDrawer: () => set({ drawerOpen: false }),
  openDrawer: (tab) => set({ drawerOpen: true, drawerTab: rememberTab(tab) }),
  setDrawerTab: (tab) => set({ drawerTab: rememberTab(tab) }),
  setDrawerScoped: (drawerScoped) => set({ drawerScoped })
}))

document.documentElement.setAttribute("data-theme", useUi.getState().theme)
