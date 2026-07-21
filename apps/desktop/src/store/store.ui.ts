import { create } from "zustand"

// Chrome-level UI state. Kept out of the engine store so a re-render caused by
// an event never fights with a theme flip, and so the terminals can subscribe
// to the theme without reaching into the DOM.

export type Theme = "dark" | "light"

interface UiState {
  theme: Theme
  sidebarCollapsed: boolean
  toggleTheme: () => void
  toggleSidebar: () => void
  collapseSidebar: () => void
}

const stored = (): Theme => (localStorage.getItem("matisa.theme") === "light" ? "light" : "dark")

export const useUi = create<UiState>()((set) => ({
  theme: stored(),
  sidebarCollapsed: false,
  toggleTheme: () =>
    set((s) => {
      const theme: Theme = s.theme === "dark" ? "light" : "dark"
      localStorage.setItem("matisa.theme", theme)
      document.documentElement.setAttribute("data-theme", theme)
      return { theme }
    }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  collapseSidebar: () => set({ sidebarCollapsed: true })
}))

document.documentElement.setAttribute("data-theme", useUi.getState().theme)
