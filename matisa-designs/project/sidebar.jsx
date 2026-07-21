/* Sidebar: search, sections, service rows */

const StatusDot = ({ status, size = 8 }) => {
  const color =
    status === "running" ? "var(--success)" :
    status === "stopped" ? "var(--danger)" :
    status === "starting" ? "var(--warning)" :
    "var(--text-faint)";
  return (
    <span
      style={{
        width: size, height: size, borderRadius: "999px",
        background: color,
        boxShadow: "none",
        position: "relative",
        display: "inline-block",
      }}

    />
  );
};

const ServiceRow = ({ s, kind, active, onClick }) => {
  const icon = kind === "stack"
    ? <Icons.Stack size={14} />
    : <Icons.Code size={14} />;

  return (
    <div
      className={`svc-row ${active ? "active" : ""}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
    >
      <span className="svc-icon">{icon}</span>
      <span className="svc-body">
        <span className="svc-name">{s.name}</span>
        <span className="svc-meta">
          <StatusDot status={s.status} size={6} />
          <span className="svc-port">:{s.port}</span>
          {s.status === "running" && s.cpu != null && (
            <span className="svc-stat">
              <span className="dot-sep">·</span>{s.cpu.toFixed(1)}%
              <span className="dot-sep">·</span>{s.mem}M
            </span>
          )}
          {s.branch && (
            <span className="svc-branch">
              <Icons.Branch size={9} sw={1.8} />{s.branch}
            </span>
          )}
        </span>
      </span>
      <span className="svc-actions" onClick={(e) => e.stopPropagation()}>
        {s.status === "running"
          ? <button className="ico danger-hover" title="Stop"><Icons.Stop size={10} /></button>
          : <button className="ico success-hover" title="Start"><Icons.Play size={10} /></button>
        }
        <button className="ico" title="Open URL"><Icons.Compass size={13} /></button>
        <button className="ico" title="Copy URL"><Icons.Copy size={12} /></button>
        <button className="ico" title="Open folder"><Icons.Folder size={13} /></button>
      </span>
    </div>
  );
};

const SectionHeader = ({ section, expanded, onToggle, parent }) => {
  const dots = (section.services || []).slice(0, 5);
  const padding = parent ? 8 : 0;
  return (
    <div className={`section-head ${parent ? "is-sub" : "is-top"}`} onClick={onToggle} style={{ paddingLeft: parent ? 8 : 12 }} role="button" tabIndex={0}>
      <span className="caret">{expanded ? <Icons.ChevronDown size={11} sw={2}/> : <Icons.ChevronRight size={11} sw={2}/>}</span>
      <span className="section-title">{section.title}</span>
      <span className="section-count">{section.count ?? section.services.length}</span>
      {!expanded && (
        <span className="section-dots">
          {dots.map((s, i) => <StatusDot key={i} status={s.status} size={5} />)}
          {(section.services?.length || 0) > 5 && <span className="dots-more">+{section.services.length - 5}</span>}
        </span>
      )}
      <span className="section-spacer" />
      <span className="section-tools" onClick={(e) => e.stopPropagation()}>
        <button className="ico"><Icons.Play size={11} /></button>
        <button className="ico"><Icons.Stop size={9} /></button>
      </span>
    </div>
  );
};

const ParentHeader = ({ title, count, expanded, onToggle }) => (
  <button className="parent-head" onClick={onToggle}>
    {expanded ? <Icons.ChevronDown size={11} sw={2}/> : <Icons.ChevronRight size={11} sw={2}/>}
    <span>{title}</span>
    <span className="parent-count">{count}</span>
  </button>
);

const Sidebar = ({ selectedId, onSelect, onToggleTheme, theme, onCollapse }) => {
  const [query, setQuery] = React.useState("");
  const [collapsed, setCollapsed] = React.useState(() => {
    const m = {};
    DATA.sections.forEach(s => { m[s.id] = !!s.collapsed; });
    return m;
  });
  const [parentCollapsed, setParentCollapsed] = React.useState({ Projects: false, "Compose Stacks": false });

  /* Group by parent */
  const byParent = {};
  DATA.sections.forEach(sec => {
    (byParent[sec.parent] ||= []).push(sec);
  });

  const matches = (s) => !query || s.name.toLowerCase().includes(query.toLowerCase());

  const allCollapsed = DATA.sections.every(s => collapsed[s.id]);
  const toggleAll = () => {
    const next = {};
    DATA.sections.forEach(s => { next[s.id] = !allCollapsed; });
    setCollapsed(next);
  };

  return (
    <aside className="sidebar">
      <div className="side-top">
        <div className="workspace-pill">
          <span className="ws-avatar"><Icons.FolderOpen size={13} /></span>
          <span className="ws-name">~/dev</span>
          <span className="ws-caret"><Icons.ChevronDown size={11} sw={2}/></span>
        </div>
        <div className="side-top-tools">
          <button className="ico-btn" title={allCollapsed ? "Expand all" : "Collapse all"} onClick={toggleAll}>
            {allCollapsed ? <Icons.ExpandAll size={14}/> : <Icons.CollapseAll size={14}/>}
          </button>
          <button className="ico-btn" title="Toggle theme" onClick={onToggleTheme}>
            {theme === "dark" ? <Icons.Sun size={14}/> : <Icons.Moon size={14}/>}
          </button>
          <button className="ico-btn" title="Add service"><Icons.Plus size={14}/></button>
          <button className="ico-btn" title="Collapse sidebar" onClick={onCollapse}><Icons.PanelLeft size={14}/></button>
        </div>
      </div>

      <div className="search-wrap">
        <Icons.Search size={13} />
        <input
          type="text"
          placeholder="Search services"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="side-list scroll">
        {Object.entries(byParent).map(([parent, sections]) => (
          <div key={parent} className="parent-group">
            <ParentHeader
              title={parent}
              count={sections.reduce((a, s) => a + (s.count ?? s.services.length), 0)}
              expanded={!parentCollapsed[parent]}
              onToggle={() => setParentCollapsed(p => ({ ...p, [parent]: !p[parent] }))}
            />
            {!parentCollapsed[parent] && sections.map(sec => {
              const expanded = !collapsed[sec.id];
              const visibleServices = (sec.services || []).filter(matches);
              return (
                <div key={sec.id} className={`section ${sec.muted ? "muted" : ""}`}>
                  <SectionHeader
                    section={sec}
                    parent={parent}
                    expanded={expanded}
                    onToggle={() => setCollapsed(c => ({ ...c, [sec.id]: !c[sec.id] }))}
                  />
                  {expanded && (
                    <div className="section-body">
                      {visibleServices.map(s => (
                        <ServiceRow
                          key={s.id}
                          s={s}
                          kind={s.kind}
                          active={selectedId === s.id || (s.selected && !selectedId)}
                          onClick={() => onSelect(s.id)}
                        />
                      ))}
                      {visibleServices.length === 0 && sec.id !== "unmanaged" && (
                        <div className="empty-row">No services match</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        <div style={{ height: 24 }} />
      </div>

      <div className="side-foot">
        <span className="foot-dot" />
        <span className="foot-text">14 running · 9 stopped</span>
        <span className="foot-spacer" />
        <span className="foot-mem">2.1 GB</span>
      </div>
    </aside>
  );
};

const SidebarStyles = () => (
  <style>{`
    .sidebar {
      width: 320px;
      flex-shrink: 0;
      background: var(--sidebar-bg);
      border-right: 1px solid var(--border-soft);
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }

    .side-top {
      padding: 14px 14px 10px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .workspace-pill {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 5px 8px 5px 6px;
      background: var(--card-bg);
      border: 1px solid var(--border-soft);
      border-radius: 8px;
      font-size: 12.5px;
      font-weight: 500;
      color: var(--text);
    }
    .ws-avatar { color: var(--accent); display:inline-flex; }
    .ws-caret { color: var(--text-dim); display:inline-flex; }
    .side-top-tools { margin-left: auto; display:flex; gap: 4px; }

    .ico-btn {
      width: 28px; height: 28px;
      border-radius: 7px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--text-muted);
      display: inline-flex; align-items: center; justify-content: center;
      transition: all .14s;
    }
    .ico-btn:hover { background: var(--card-bg); color: var(--text); border-color: var(--border-soft); }

    .search-wrap {
      margin: 0 14px 10px;
      display: flex; align-items: center; gap: 8px;
      padding: 0 10px;
      height: 32px;
      background: var(--input-bg);
      border: 1px solid var(--border-soft);
      border-radius: 8px;
      color: var(--text-dim);
    }
    .search-wrap:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    .search-wrap input {
      flex: 1; background: transparent; border: 0; outline: none;
      color: var(--text); font: inherit; font-size: 13px;
    }
    .search-wrap input::placeholder { color: var(--text-dim); }
    .kbd {
      font-family: var(--font-mono);
      font-size: 10.5px;
      padding: 2px 5px;
      border-radius: 4px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      color: var(--text-dim);
    }

    .side-list { flex: 1; min-height: 0; padding: 4px 8px 8px; }

    .parent-group + .parent-group { margin-top: 12px; }
    .parent-head {
      display: flex; align-items: center; gap: 6px;
      width: 100%;
      padding: 8px 8px 6px;
      background: transparent; border: 0;
      font-family: var(--font-mono);
      font-size: 10.5px;
      letter-spacing: 0.08em;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--text-faint);
    }
    .parent-count {
      margin-left: auto;
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-faint);
      background: var(--card-bg);
      padding: 1px 6px;
      border-radius: 4px;
    }

    .section { margin: 1px 0; }
    .section.muted .section-head { opacity: 0.65; }
    .section-head {
      display: flex; align-items: center; gap: 8px;
      width: 100%;
      padding: 7px 8px;
      background: transparent;
      border: 0;
      border-radius: 7px;
      color: var(--text-muted);
      text-align: left;
    }
    .section-head:hover { background: var(--card-bg); color: var(--text); }
    .section-head .caret { color: var(--text-dim); display:inline-flex; }
    .section-title { font-size: 12.5px; font-weight: 500; }
    .section-count {
      font-family: var(--font-mono);
      font-size: 10.5px;
      color: var(--text-faint);
      background: var(--card-bg);
      padding: 1px 5px;
      border-radius: 4px;
      min-width: 18px;
      text-align: center;
    }
    .section-dots { display: inline-flex; gap: 3px; align-items: center; margin-left: 4px; }
    .dots-more { font-family: var(--font-mono); font-size: 10px; color: var(--text-faint); margin-left: 2px; }
    .section-spacer { flex: 1; }
    .section-tools { display: inline-flex; gap: 2px; opacity: 0; transition: opacity .12s; }
    .section-head:hover .section-tools { opacity: 1; }

    .section-body { padding: 2px 0 4px; display:flex; flex-direction: column; gap: 7px; }

    .svc-row {
      position: relative;
      display: flex; align-items: center; gap: 10px;
      width: 100%;
      padding: 9px 10px 9px 12px;
      background: var(--card-bg);
      border: 1px solid var(--border-soft);
      border-radius: 10px;
      color: var(--text);
      text-align: left;
      cursor: pointer;
      transition: background .14s, border-color .14s, transform .08s;
    }
    .section-head { cursor: pointer; }
    .svc-row:hover { background: var(--card-bg-hover); }
    .svc-row.active {
      background: var(--card-bg-active);
      border-color: var(--border-strong);
      box-shadow: var(--shadow-inset);
    }
    .svc-row.active::before {
      content: "";
      position: absolute; left: -8px; top: 8px; bottom: 8px; width: 2px;
      background: var(--accent); border-radius: 2px;
    }
    .svc-icon {
      width: 28px; height: 28px;
      border-radius: 7px;
      background: var(--accent-tint);
      border: 1px solid var(--accent-tint-bot);
      color: var(--accent);
      display: inline-flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .svc-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
    .svc-name {
      font-size: 13px; font-weight: 500;
      color: var(--text);
      letter-spacing: -0.005em;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .svc-meta {
      display: inline-flex; align-items: center; gap: 6px;
      font-family: var(--font-mono);
      font-size: 10.5px;
      color: var(--text-muted);
    }
    .svc-port { color: var(--text-muted); }
    .svc-stat { color: var(--text-faint); }
    .dot-sep { opacity: 0.5; }
    .svc-branch { display:inline-flex; align-items:center; gap:3px; color: var(--text-faint); margin-left: auto; }

    .svc-actions {
      display: inline-flex; align-items: center; gap: 1px;
      opacity: 0;
      transition: opacity .12s;
    }
    .svc-row:hover .svc-actions, .svc-row.active .svc-actions { opacity: 1; }

    .ico {
      width: 24px; height: 24px;
      display: inline-flex; align-items: center; justify-content: center;
      background: transparent; border: 0; border-radius: 5px;
      color: var(--text-muted);
      transition: all .12s;
    }
    .ico:hover { background: var(--chip-bg); color: var(--text); }
    .ico.success-hover:hover { color: var(--success); background: var(--success-soft); }
    .ico.danger-hover:hover { color: var(--danger); background: var(--danger-soft); }

    .empty-row {
      padding: 6px 12px;
      font-size: 11.5px;
      color: var(--text-faint);
    }

    .side-foot {
      padding: 10px 16px;
      border-top: 1px solid var(--border-soft);
      display: flex; align-items: center; gap: 8px;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
    }
    .foot-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 0 3px var(--success-soft);
    }
    .foot-spacer { flex: 1; }

    @keyframes pulse-ring {
      0% { box-shadow: 0 0 0 0 oklch(from var(--success) l c h / 0.5); }
      100% { box-shadow: 0 0 0 6px oklch(from var(--success) l c h / 0); }
    }
    .status-dot-pulse {
      animation: pulse-ring 1.8s ease-out infinite;
    }
  `}</style>
);

window.Sidebar = Sidebar;
window.SidebarStyles = SidebarStyles;
window.StatusDot = StatusDot;
