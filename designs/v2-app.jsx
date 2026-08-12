/* Matisa 2 — app shell */

const App = () => {
  const [theme, setTheme] = React.useState("dark");
  const [services, setServices] = React.useState(SERVICES);
  const [selectedId, setSelectedId] = React.useState("web");
  const [collapsed, setCollapsed] = React.useState(false);

  React.useEffect(() => { document.documentElement.setAttribute("data-theme", theme); }, [theme]);
  React.useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") { e.preventDefault(); setCollapsed(c => !c); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleRun = (id) => setServices(list => list.map(s => {
    if (s.id !== id) return s;
    const running = s.status === "running";
    return running
      ? { ...s, status: "stopped", statusNote: "stopped just now", pid: null, cpu: 0, mem: 0, uptime: "—" }
      : { ...s, status: "running", statusNote: "up 2s", pid: s.pid || 8000 + Math.floor(Math.random() * 900), cpu: 0.6, mem: Math.max(12, s.mem || 24), uptime: "2s" };
  }));

  const service = services.find(s => s.id === selectedId) || services[0];
  const issues = services.filter(s => s.status === "errored").length;

  return (
    <div className="desktop">
      <div className="window">
        <div className="titlebar">
          <div className="traffic"><span className="tl c" /><span className="tl m" /><span className="tl x" /></div>
          <div className="tb-title">
            <span className="tb-brand serif">Matisa</span>
            <span className="tb-sub mono">local services</span>
          </div>
          <div className="tb-right">
            {issues > 0 && (
              <button className="issue-pill" title="Show services with issues">
                <Icons.Warn size={12} /> {issues} {issues === 1 ? "issue" : "issues"}
              </button>
            )}
            <button className={`tswitch ${theme}`} title="Toggle appearance" onClick={() => setTheme(t => t === "dark" ? "light" : "dark")}>
              <span className="tsw-knob">{theme === "dark" ? <Icons.Moon size={11} /> : <Icons.Sun size={11} />}</span>
            </button>
            <IconBtn icon={Icons.Refresh} label="Rescan projects" />
          </div>
        </div>
        <div className="wbody">
          {collapsed
            ? <Rail services={services} selectedId={selectedId} onSelect={setSelectedId} onExpand={() => setCollapsed(false)} />
            : <Sidebar services={services} selectedId={selectedId} onSelect={setSelectedId} onToggle={toggleRun} onCollapse={() => setCollapsed(true)} />}
          <MainPanel service={service} onToggle={toggleRun} />
        </div>
      </div>
      <UIStyles /><SidebarStyles /><TerminalStyles /><MainStyles /><AppStyles />
    </div>
  );
};

const AppStyles = () => (
  <style>{`
.window{width:min(1500px,100%);height:min(950px,100%);background:var(--canvas);border-radius:18px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 0 0 1px oklch(1 0 0/0.06),0 60px 120px oklch(0 0 0/0.55),0 14px 44px oklch(0 0 0/0.4)}
[data-theme="light"] .window{box-shadow:0 0 0 1px oklch(0 0 0/0.07),0 60px 120px oklch(0 0 0/0.16),0 14px 44px oklch(0 0 0/0.08)}
.titlebar{height:44px;flex:none;display:flex;align-items:center;gap:16px;padding:0 14px;background:var(--frame);border-bottom:1px solid var(--line-soft);user-select:none}
.traffic{display:inline-flex;gap:8px}
.tl{width:11px;height:11px;border-radius:50%;box-shadow:inset 0 0 0 .5px oklch(0 0 0/0.15)}
.tl.c{background:oklch(0.68 0.19 24)}.tl.m{background:oklch(0.82 0.14 82)}.tl.x{background:oklch(0.75 0.16 148)}
.tb-title{flex:1;display:flex;align-items:baseline;justify-content:center;gap:10px}
.tb-brand{font-size:17px;color:var(--text);line-height:1}
.tb-sub{font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:var(--faint)}
.tb-right{display:inline-flex;align-items:center;gap:6px}
.issue-pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 11px;border-radius:999px;background:var(--coral-wash);color:var(--coral);font-size:11px;font-weight:500;white-space:nowrap;transition:filter .14s}
.issue-pill:hover{filter:brightness(1.12)}
.tswitch{width:46px;height:26px;border-radius:999px;background:var(--sunken);box-shadow:inset 0 0 0 1px var(--line-soft);display:flex;align-items:center;padding:2px;transition:background .18s}
.tsw-knob{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;background:var(--surface-2);color:var(--muted);transition:transform .24s cubic-bezier(.6,.05,.3,1),background .2s,color .2s}
.tswitch.light .tsw-knob{transform:translateX(20px);background:var(--amber);color:oklch(0.25 0.05 80)}
.wbody{flex:1;min-height:0;display:flex;overflow:hidden}
  `}</style>
);

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
