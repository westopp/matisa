/* Matisa 2 — service navigator */

const kindIcon = (s) => Icons[s.icon] || Icons.Code;

const Row = ({ s, selected, onSelect, onToggle }) => (
  <div className={`srow ${selected ? "is-sel" : ""} st-${s.status}`} onClick={() => onSelect(s.id)}>
    <span className="srow-mark" />
    <span className={`savatar tone-${TONE[s.status]}`}>{React.createElement(kindIcon(s), { size: 14 })}</span>
    <span className="srow-text">
      <span className="srow-name">{s.name}</span>
      <span className="srow-meta mono">
        <Dot status={s.status} size={5} pulse />
        {s.port ? `:${s.port}` : s.kind}
        <span className="srow-env">{s.env}</span>
      </span>
    </span>
    <button className={`srow-act ${s.status === "running" ? "stop" : "start"}`} title={s.status === "running" ? "Stop" : "Start"}
      onClick={(e) => { e.stopPropagation(); onToggle(s.id); }}>
      {s.status === "running" ? <Icons.Stop size={9} /> : <Icons.Play size={10} />}
    </button>
  </div>
);

const Sidebar = ({ services, selectedId, onSelect, onToggle, onCollapse }) => {
  const [q, setQ] = React.useState("");
  const [filter, setFilter] = React.useState("all");
  const [closed, setClosed] = React.useState({});
  const byId = Object.fromEntries(services.map(s => [s.id, s]));
  const counts = {
    all: services.length,
    running: services.filter(s => s.status === "running").length,
    issues: services.filter(s => s.status === "errored").length,
  };
  const keep = (s) => {
    if (filter === "running" && s.status !== "running") return false;
    if (filter === "issues" && s.status !== "errored") return false;
    if (q && !(s.name + s.group + (s.port || "")).toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  };
  const stopped = services.filter(s => s.status !== "running").length;

  return (
    <nav className="side">
      <header className="side-head">
        <button className="proj">
          <Icons.FolderOpen size={14} />
          <span className="proj-name serif">matisa</span>
          <Icons.ChevronDown size={12} />
        </button>
        <IconBtn icon={Icons.PanelClose} label="Collapse sidebar  ⌘\" onClick={onCollapse} />
      </header>

      <div className="side-search">
        <Icons.Search size={12} />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search services" />
        {q ? <button className="clr" onClick={() => setQ("")}><Icons.X size={11} /></button> : <span className="kbd">⌘K</span>}
      </div>

      <div className="segs">
        {[["all", "All"], ["running", "Running"], ["issues", "Issues"]].map(([k, l]) => (
          <button key={k} className={`seg ${filter === k ? "on" : ""} ${k === "issues" && counts.issues ? "warnful" : ""}`} onClick={() => setFilter(k)}>
            {l}<span className="seg-n mono">{counts[k]}</span>
          </button>
        ))}
      </div>

      <div className="side-list scroll">
        {TREE.map(sec => {
          const groups = sec.groups.map(g => ({ ...g, items: g.ids.map(id => byId[id]).filter(keep) })).filter(g => g.items.length);
          if (!groups.length) return null;
          return (
            <div className="sec" key={sec.section}>
              <div className="sec-label micro">{sec.section}</div>
              {groups.map(g => {
                const key = sec.section + g.title, isClosed = closed[key];
                return (
                  <div className="grp" key={key}>
                    <button className="grp-head" onClick={() => setClosed(c => ({ ...c, [key]: !c[key] }))}>
                      <span className={`grp-caret ${isClosed ? "closed" : ""}`}><Icons.ChevronDown size={11} /></span>
                      <span className="grp-title">{g.title}</span>
                      <span className="grp-n mono">{g.items.length}</span>
                    </button>
                    {!isClosed && <div className="grp-items">
                      {g.items.map(s => <Row key={s.id} s={s} selected={s.id === selectedId} onSelect={onSelect} onToggle={onToggle} />)}
                    </div>}
                  </div>
                );
              })}
            </div>
          );
        })}
        <button className="btn tone-dashed sz-sm add-svc"><Icons.Plus size={12} /> Add service</button>
      </div>

      <footer className="side-foot">
        <span className="foot-stat"><Dot status="running" size={6} pulse /> {counts.running} running</span>
        <span className="foot-sep">·</span>
        <span className="foot-stat dimmed">{stopped} idle</span>
        <span className="foot-disk mono">0.3 GB</span>
      </footer>
    </nav>
  );
};

const Rail = ({ services, selectedId, onSelect, onExpand }) => (
  <nav className="rail">
    <IconBtn icon={Icons.PanelOpen} label="Show sidebar  ⌘\" onClick={onExpand} />
    <div className="rail-sep" />
    <div className="rail-list scroll">
      {services.map(s => (
        <button key={s.id} className={`rail-item ${s.id === selectedId ? "on" : ""} tone-${TONE[s.status]}`} title={`${s.name} · ${s.status}`} onClick={() => onSelect(s.id)}>
          {React.createElement(kindIcon(s), { size: 15 })}
          <Dot status={s.status} size={5} />
        </button>
      ))}
    </div>
  </nav>
);

const SidebarStyles = () => (
  <style>{`
.side{width:288px;flex:none;height:100%;display:flex;flex-direction:column;background:var(--frame);border-right:1px solid var(--line-soft);min-height:0}
.side-head{display:flex;align-items:center;gap:6px;padding:12px 12px 8px}
.proj{display:inline-flex;align-items:center;gap:8px;height:32px;padding:0 11px;border-radius:10px;color:var(--muted);transition:background .14s}
.proj:hover{background:var(--surface-2);color:var(--text)}
.proj-name{font-size:18px;color:var(--text);line-height:1}
.proj svg:last-child{color:var(--faint)}
.side-head .ibtn{margin-left:auto}

.side-search{display:flex;align-items:center;gap:8px;margin:0 12px;height:34px;padding:0 10px;border-radius:11px;background:var(--sunken);color:var(--dim);box-shadow:inset 0 0 0 1px var(--line-soft)}
.side-search:focus-within{box-shadow:inset 0 0 0 1px var(--lav)}
.side-search input{flex:1;min-width:0;background:none;border:0;outline:none;color:var(--text);font-size:12.5px}
.side-search input::placeholder{color:var(--faint)}
.side-search .clr{color:var(--dim);display:grid;place-items:center}

.segs{display:flex;gap:2px;margin:10px 12px 4px;padding:2px;background:var(--sunken);border-radius:10px}
.seg{flex:1;height:26px;border-radius:8px;font-size:11.5px;font-weight:500;color:var(--dim);display:inline-flex;align-items:center;justify-content:center;gap:5px;transition:all .14s}
.seg:hover{color:var(--text)}
.seg.on{background:var(--surface-2);color:var(--text)}
.seg-n{font-size:9.5px;color:var(--faint)}
.seg.warnful .seg-n{color:var(--coral)}

.side-list{flex:1;min-height:0;padding:8px 10px 12px}
.sec+.sec{margin-top:14px}
.sec-label{padding:8px 4px 4px}
.grp{margin-bottom:2px}
.grp-head{display:flex;align-items:center;gap:6px;width:100%;height:26px;padding:0 4px;border-radius:7px;color:var(--muted)}
.grp-head:hover{color:var(--text)}
.grp-caret{display:grid;place-items:center;color:var(--faint);transition:transform .16s}
.grp-caret.closed{transform:rotate(-90deg)}
.grp-title{font-size:12px;font-weight:500;letter-spacing:-0.005em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.grp-n{font-size:9.5px;color:var(--faint);margin-left:auto;flex:none}
.grp-items{display:flex;flex-direction:column;gap:2px;padding:2px 0 6px}

.srow{position:relative;display:flex;align-items:center;gap:10px;padding:7px 8px 7px 10px;border-radius:12px;cursor:pointer;transition:background .14s}
.srow:hover{background:var(--surface-2)}
.srow.is-sel{background:var(--surface-2)}
.srow-mark{position:absolute;left:2px;top:50%;transform:translateY(-50%);width:2px;height:0;border-radius:2px;background:var(--lav);transition:height .18s}
.srow.is-sel .srow-mark{height:20px}
.savatar{width:28px;height:28px;flex:none;border-radius:9px;display:grid;place-items:center;background:var(--surface-2);color:var(--dim)}
.srow.is-sel .savatar,.srow:hover .savatar{background:var(--surface)}
.srow.st-running .savatar{color:var(--mint)}
.srow.st-errored .savatar{color:var(--coral)}
.srow-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.srow-name{font-size:12.5px;font-weight:500;letter-spacing:-0.005em;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.srow-meta{display:inline-flex;align-items:center;gap:6px;font-size:10px;color:var(--faint);white-space:nowrap}
.srow-env{color:var(--dim);background:var(--sunken);border-radius:4px;padding:1px 5px}
.srow-act{width:24px;height:24px;flex:none;border-radius:8px;display:grid;place-items:center;opacity:0;color:var(--dim);transition:all .14s}
.srow:hover .srow-act,.srow.is-sel .srow-act{opacity:1}
.srow-act.start:hover{color:var(--mint);background:var(--mint-wash)}
.srow-act.stop:hover{color:var(--coral);background:var(--coral-wash)}
.add-svc{width:100%;justify-content:center;margin-top:10px;height:32px}

.side-foot{display:flex;align-items:center;gap:6px;padding:0 16px;height:40px;border-top:1px solid var(--line-soft);font-size:11px;color:var(--muted);flex:none}
.foot-stat{display:inline-flex;align-items:center;gap:6px}
.foot-stat.dimmed{color:var(--faint)}
.foot-sep{color:var(--faint)}
.foot-disk{margin-left:auto;font-size:10.5px;color:var(--faint)}

.rail{width:60px;flex:none;height:100%;display:flex;flex-direction:column;align-items:center;gap:6px;padding:12px 0;background:var(--frame);border-right:1px solid var(--line-soft)}
.rail-sep{width:24px;height:1px;background:var(--line-soft);margin:2px 0 4px}
.rail-list{flex:1;min-height:0;display:flex;flex-direction:column;gap:6px;align-items:center;width:100%}
.rail-item{position:relative;width:34px;height:34px;border-radius:11px;display:grid;place-items:center;color:var(--dim);background:transparent;transition:all .14s}
.rail-item:hover{background:var(--surface-2);color:var(--text)}
.rail-item.on{background:var(--surface-2);color:var(--text);box-shadow:inset 0 0 0 1px var(--line)}
.rail-item .dot{position:absolute;right:3px;bottom:3px}
  `}</style>
);

Object.assign(window, { Sidebar, Rail, SidebarStyles, kindIcon });
