/* Matisa 2 — app shell: card board (full view ⇄ rail) + detail pane */

const withTransition = (fn) => fn();

const App = () => {
  const [theme, setTheme] = React.useState("dark");
  const [services, setServices] = React.useState(SERVICES);
  const [selectedId, setSelectedId] = React.useState("web");
  const [sideOpen, setSideOpen] = React.useState(true);
  const lastRef = React.useRef(null);

  React.useEffect(() => { document.documentElement.setAttribute("data-theme", theme); }, [theme]);
  React.useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") { e.preventDefault(); withTransition(() => setSideOpen(o => !o)); }
      else if (e.key === "Escape") withTransition(() => setSelectedId(null));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const toggleRun = (id) => setServices(list => list.map(s => s.id !== id ? s : (
    s.status === "running"
      ? { ...s, status: "stopped", statusNote: "stopped just now", pid: null, cpu: 0, mem: 0, uptime: "—" }
      : { ...s, status: "running", statusNote: "up 3s", pid: s.pid || 8000 + Math.floor(Math.random() * 900), cpu: 0.6, mem: Math.max(14, s.mem || 24), uptime: "3s" }
  )));

  const service = services.find(s => s.id === selectedId);
  if (service) lastRef.current = service.id;
  const shown = service || services.find(s => s.id === lastRef.current);
  const issues = services.filter(s => s.status === "errored").length;
  const focused = !!service;

  return (
    <div className="desktop">
      <div className="window">
        <header className="titlebar">
          <div className="traffic"><span className="tl c" /><span className="tl m" /><span className="tl x" /></div>
          <div className="tb-mid">
            <span className="brand serif">Matisa</span>
            <span className="tb-dot">·</span>
            <span className="tb-sub mono">local services</span>
          </div>
          <div className="tb-right">
            {issues > 0 && <button className="issue-pill" title="Services with issues"><Icons.Warn size={12} /> {issues}</button>}
            <button className={`tsw ${theme}`} title="Toggle appearance" onClick={() => setTheme(t => t === "dark" ? "light" : "dark")}>
              <span className="tsw-k">{theme === "dark" ? <Icons.Moon size={11} /> : <Icons.Sun size={11} />}</span>
            </button>
            <IconBtn icon={Icons.Refresh} label="Rescan projects" />
          </div>
        </header>

        <div className="wbody">
          {(!focused || sideOpen) && (
            <div className={`fleet ${focused ? "as-rail" : ""}`}>
              {focused && (
                <div className="fleet-head">
                  <IconBtn icon={Icons.Grid} label="Expand to full board  esc" size={14} onClick={() => withTransition(() => setSelectedId(null))} />
                  <IconBtn icon={Icons.PanelClose} label="Hide list  ⌘\" size={14} onClick={() => withTransition(() => setSideOpen(false))} />
                </div>
              )}
              <Board services={services} selectedId={selectedId} compact={focused}
                onOpen={(id) => withTransition(() => { setSelectedId(id); setSideOpen(true); })} onToggle={toggleRun} />
            </div>
          )}
          <div className={`pane-wrap ${focused && sideOpen ? "open" : ""} ${focused && !sideOpen ? "solo" : ""}`} aria-hidden={!focused}>
            {shown && <Detail service={shown} onToggle={toggleRun} showSidebarBtn={!sideOpen} onShowSidebar={() => setSideOpen(true)} />}
          </div>
        </div>
      </div>
      <BoardUIStyles /><BoardStyles /><DetailStyles /><ShellStyles />
    </div>
  );
};

const ShellStyles = () => (
  <style>{`
.window{width:min(1500px,100%);height:min(950px,100%);background:var(--canvas);border-radius:18px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 0 0 1px oklch(1 0 0/.07),0 60px 120px oklch(0 0 0/.55),0 14px 44px oklch(0 0 0/.4)}
[data-theme="light"] .window{box-shadow:0 0 0 1px oklch(0 0 0/.07),0 60px 120px oklch(0 0 0/.16),0 14px 44px oklch(0 0 0/.08)}
.titlebar{flex:none;height:46px;display:flex;align-items:center;gap:16px;padding:0 14px;background:var(--sheet);border-bottom:1px solid var(--line);user-select:none}
.traffic{display:inline-flex;gap:8px}
.tl{width:11px;height:11px;border-radius:50%;box-shadow:inset 0 0 0 .5px oklch(0 0 0/.15)}
.tl.c{background:oklch(.68 .19 24)}.tl.m{background:oklch(.82 .14 82)}.tl.x{background:oklch(.75 .16 148)}
.tb-mid{flex:1;display:flex;align-items:baseline;justify-content:center;gap:9px}
.brand{font-size:17px;line-height:1;letter-spacing:-0.03em}
.tb-dot{color:var(--dim)}
.tb-sub{font-size:9.5px;letter-spacing:0.16em;text-transform:uppercase;color:var(--dim)}
.tb-right{display:inline-flex;align-items:center;gap:6px}
.issue-pill{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;background:var(--coral-wash);color:var(--coral);font-size:11.5px;font-weight:600;white-space:nowrap}
.issue-pill:hover{filter:brightness(1.12)}
.tsw{width:44px;height:25px;border-radius:999px;background:var(--raise);display:flex;align-items:center;padding:2px}
.tsw-k{width:21px;height:21px;border-radius:50%;display:grid;place-items:center;background:var(--raise-2);color:var(--muted);transition:transform .24s cubic-bezier(.6,.05,.3,1),background .2s,color .2s}
.tsw.light .tsw-k{transform:translateX(19px);background:var(--amber);color:oklch(.25 .05 80)}

.wbody{flex:1;min-height:0;display:flex;overflow:hidden}
.fleet{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;min-height:0}
.fleet.as-rail{background:var(--sheet);border-right:1px solid var(--line)}
.fleet-head{flex:none;height:44px;display:flex;align-items:center;justify-content:flex-end;gap:4px;padding:0 12px}

/* one view — the detail pane's width drives the layout */
.pane-wrap{flex:0 0 0px;min-width:0;display:flex;overflow:hidden;opacity:0;transition:flex-basis .42s cubic-bezier(.32,.86,.24,1),opacity .3s ease}
.pane-wrap.open{flex-basis:calc(100% - 318px);opacity:1}
.pane-wrap.solo{flex-basis:100%;opacity:1}
.pane-wrap>.detail{width:100%}
@media (max-width:1080px){.pane-wrap.open{flex-basis:calc(100% - 272px)}}
  `}</style>
);

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
