/* App shell: macOS window + sidebar + main */

const Titlebar = ({ theme, onToggleTheme, sidebarCollapsed, onToggleSidebar }) => (
  <div className="titlebar">
    <div className="traffic">
      <span className="t-light close" />
      <span className="t-light min" />
      <span className="t-light max" />
    </div>
    <div className="title-text">
      <span className="brand">Matisa</span>
      <span className="brand-sub">·</span>
      <span className="title-sub">Local Services</span>
    </div>
    <div className="title-right">
      <button className="theme-toggle" onClick={onToggleTheme} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>
        <span className={`tt-knob ${theme}`}>
          {theme === "dark" ? <Icons.Moon size={12} /> : <Icons.Sun size={12} />}
        </span>
        <span className="tt-track">
          <span className={`tt-pill ${theme}`} />
        </span>
      </button>
      <button className="ico-btn" title="Refresh"><Icons.Refresh size={14}/></button>
      <button className={`ico-btn ${sidebarCollapsed ? "" : "active"}`} title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"} onClick={onToggleSidebar}><Icons.PanelLeft size={14}/></button>
    </div>
  </div>
);

const App = () => {
  const [theme, setTheme] = React.useState("dark");
  const [selectedId, setSelectedId] = React.useState("pglib-docs");
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);

  React.useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const toggleTheme = () => setTheme(t => t === "dark" ? "light" : "dark");

  return (
    <div className="desktop">
      <div className="window">
        <Titlebar
          theme={theme}
          onToggleTheme={toggleTheme}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed(c => !c)}
        />
        <div className="window-body">
          <div className={`sidebar-slot ${sidebarCollapsed ? "collapsed" : ""}`}>
            <Sidebar
              selectedId={selectedId}
              onSelect={setSelectedId}
              theme={theme}
              onToggleTheme={toggleTheme}
              onCollapse={() => setSidebarCollapsed(true)}
            />
          </div>
          <MainPanel service={SELECTED} />
        </div>
      </div>
      <AppStyles />
      <SidebarStyles />
      <MainStyles />
    </div>
  );
};

const AppStyles = () => (
  <style>{`
    .window {
      width: min(1480px, 100%);
      height: min(940px, 100%);
      max-height: 100%;
      background: var(--window-bg);
      border-radius: 14px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      box-shadow:
        0 0 0 1px oklch(0 0 0 / 0.4),
        0 50px 100px oklch(0 0 0 / 0.5),
        0 12px 40px oklch(0 0 0 / 0.35);
      border: 1px solid var(--border-soft);
    }
    [data-theme="light"] .window {
      box-shadow:
        0 0 0 1px oklch(0 0 0 / 0.06),
        0 50px 100px oklch(0 0 0 / 0.18),
        0 12px 40px oklch(0 0 0 / 0.1);
    }

    .titlebar {
      height: 44px;
      display: flex; align-items: center;
      padding: 0 16px;
      background: var(--titlebar-bg);
      border-bottom: 1px solid var(--border-soft);
      flex-shrink: 0;
      gap: 16px;
      user-select: none;
    }
    .traffic { display: inline-flex; gap: 8px; }
    .t-light {
      width: 12px; height: 12px; border-radius: 50%;
      display: inline-block;
      box-shadow: inset 0 0 0 0.5px oklch(0 0 0 / 0.15);
    }
    .t-light.close { background: oklch(0.65 0.22 24); }
    .t-light.min { background: oklch(0.78 0.16 80); }
    .t-light.max { background: oklch(0.7 0.18 145); }

    .title-text {
      flex: 1;
      display: inline-flex; align-items: center; gap: 9px;
      justify-content: center;
      font-size: 12.5px;
      color: var(--text-muted);
    }
    .brand {
      color: var(--text);
      font-weight: 600;
      letter-spacing: -0.005em;
    }
    .brand-sub { color: var(--text-faint); }
    .title-sub { font-weight: 400; }

    .title-right { display: inline-flex; align-items: center; gap: 4px; }

    .theme-toggle {
      position: relative;
      display: inline-flex; align-items: center;
      padding: 0 4px 0 0;
      height: 28px;
      width: 52px;
      border-radius: 14px;
      background: var(--card-bg);
      border: 1px solid var(--border-soft);
      transition: all .14s;
    }
    .theme-toggle:hover { border-color: var(--border-strong); }
    .tt-track {
      position: absolute; inset: 3px;
      border-radius: 12px;
      pointer-events: none;
    }
    .tt-knob {
      position: relative; z-index: 2;
      width: 22px; height: 22px;
      border-radius: 50%;
      margin: 0 0 0 3px;
      display: inline-flex; align-items: center; justify-content: center;
      background: var(--accent);
      color: var(--accent-fg);
      transition: transform .22s cubic-bezier(.7,.1,.3,1), background .2s;
      box-shadow: 0 1px 3px oklch(0 0 0 / 0.3);
    }
    .tt-knob.light { transform: translateX(24px); background: var(--warning); }

    .window-body {
      flex: 1;
      display: flex;
      min-height: 0;
      overflow: hidden;
    }
    .sidebar-slot {
      flex-shrink: 0;
      width: 320px;
      overflow: hidden;
      transition: width .24s cubic-bezier(.65,.05,.36,1);
    }
    .sidebar-slot.collapsed { width: 0; }
    .sidebar-slot .sidebar { width: 320px; }
    .ico-btn.active { background: var(--card-bg); color: var(--text); border-color: var(--border-soft); }
  `}</style>
);

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
