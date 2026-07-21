/* Main panel: service hero, metric strip, logs */

const Sparkline = ({ data, color = "var(--accent)", height = 28, width = 84 }) => {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data, 1);
  const step = width / (data.length - 1);
  const pts = data.map((v, i) => [i * step, height - (v / max) * (height - 4) - 2]);
  const path = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(" ");
  const area = path + ` L${width},${height} L0,${height} Z`;
  const gradId = `spark-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <defs>
        <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} />
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts[pts.length-1][0]} cy={pts[pts.length-1][1]} r={2} fill={color} />
    </svg>
  );
};

const MemoryBar = ({ value, max }) => {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="mem-bar">
      <div className="mem-bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
};

const ServiceHero = ({ s }) => {
  const [copied, setCopied] = React.useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(s.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="hero">
      <div className="hero-top">
        <div className="hero-id">
          <div className="hero-icon">
            <Icons.Code size={20} />
          </div>
          <div className="hero-id-text">
            <div className="hero-status-row">
              <StatusDot status={s.status} size={8} />
              <span className="hero-status-label">Running</span>
              <span className="hero-uptime">· uptime {s.uptime}</span>
            </div>
            <h1 className="hero-name">
              {s.name}
              <span className="hero-branch"><Icons.Branch size={11} sw={1.8} /> {s.branch}</span>
            </h1>
          </div>
        </div>

        <div className="hero-top-actions">
          <button className="ico-btn" title="Live updates"><Icons.Broadcast size={15} /></button>
          <button className="ico-btn" title="More"><Icons.More size={15} /></button>
        </div>
      </div>

      <div className="hero-url-row">
        <button className={`url-chip ${copied ? "copied" : ""}`} onClick={copy}>
          <Icons.Globe size={13} />
          <span className="url-text">{s.url}</span>
          <span className="url-copy"><Icons.Copy size={12} /></span>
          {copied && <span className="url-copied-badge">Copied</span>}
        </button>
        <div className="hero-actions">
          <button className="btn danger">
            <Icons.Stop size={11} /> Stop
          </button>
          <button className="btn">
            <Icons.Restart size={12} /> Restart
          </button>
          <span className="actions-divider" />
          <button className="ico-btn" title="Open in browser"><Icons.Compass size={15} /></button>
          <button className="ico-btn" title="Copy URL" onClick={copy}><Icons.Copy size={14} /></button>
          <button className="ico-btn" title="Open folder"><Icons.Folder size={15} /></button>
          <button className="ico-btn" title="Open editor"><Icons.Code size={15} /></button>
          <button className="ico-btn" title="Open terminal"><Icons.Terminal size={15} /></button>
          <button className="ico-btn danger-hover" title="Force quit"><Icons.XCircle size={15} /></button>
        </div>
      </div>
    </div>
  );
};

const MetricCard = ({ label, value, unit, sub, children, span = 1 }) => (
  <div className="metric" style={{ gridColumn: `span ${span}` }}>
    <div className="metric-label">{label}</div>
    <div className="metric-value-row">
      <span className="metric-value">
        {value}
        {unit && <span className="metric-unit">{unit}</span>}
      </span>
      {children}
    </div>
    {sub && <div className="metric-sub">{sub}</div>}
  </div>
);

const MetricStrip = ({ s }) => (
  <div className="metric-strip">
    <MetricCard label="Port" value={s.port} sub="exposed" />
    <MetricCard label="PID" value={s.pid} sub="parent process" />
    <MetricCard label="Processes" value={s.procs} sub={`${s.procs} workers`} />
    <MetricCard label="CPU" value={s.cpu.toFixed(1)} unit="%" sub="last 60s">
      <Sparkline data={s.cpuSeries} color="var(--accent)" width={84} height={26} />
    </MetricCard>
    <MetricCard label="Memory" value={s.mem} unit="MB" sub={`of ${s.memMax} MB`}>
      <div className="mem-stack">
        <MemoryBar value={s.mem} max={s.memMax} />
      </div>
    </MetricCard>
    <MetricCard label="Command" value="" span={2}>
      <code className="metric-code">{s.cmd}</code>
    </MetricCard>
    <MetricCard label="Path" value="" span={2}>
      <code className="metric-code">{s.path}</code>
    </MetricCard>
  </div>
);

const LogLine = ({ line, n }) => {
  const lvl = line.lvl;
  const renderMsg = () => {
    // syntax highlight key tokens
    let msg = line.msg;
    // urls
    return msg.split(/(https?:\/\/\S+|\/[\w./-]+\.\w+)/g).map((piece, i) => {
      if (/^https?:\/\//.test(piece)) return <span key={i} className="log-url">{piece}</span>;
      if (/^\/.*\.\w+$/.test(piece)) return <span key={i} className="log-path">{piece}</span>;
      // Numbers
      return piece.split(/(\b\d+(?:\.\d+)?(?:ms|s|MB|kb|x\d)?\b)/g).map((sub, j) => {
        if (/\b\d+(?:\.\d+)?(?:ms|s|MB|kb|x\d)?\b/.test(sub)) {
          return <span key={`${i}-${j}`} className="log-num">{sub}</span>;
        }
        // bracketed tags
        return sub.split(/(\[[^\]]+\]|\([^)]+\))/g).map((bit, k) => {
          if (/^\[.+\]$/.test(bit)) return <span key={`${i}-${j}-${k}`} className="log-tag">{bit}</span>;
          if (/^\(.+\)$/.test(bit)) return <span key={`${i}-${j}-${k}`} className="log-paren">{bit}</span>;
          return bit;
        });
      });
    });
  };

  return (
    <div className={`log-line lvl-${lvl}`}>
      <span className="log-gutter">{n}</span>
      <span className="log-time">{line.t}</span>
      <span className={`log-badge lvl-${lvl}`}>{lvl.toUpperCase()}</span>
      <span className="log-msg">{renderMsg()}</span>
    </div>
  );
};

const LogsPanel = () => {
  const [autoScroll, setAutoScroll] = React.useState(true);
  const [filter, setFilter] = React.useState("all");
  const [query, setQuery] = React.useState("");
  const scrollRef = React.useRef(null);

  const filtered = LOG_LINES.filter(l => {
    if (filter !== "all" && l.lvl !== filter && !(filter === "warn" && l.lvl === "err")) return false;
    if (query && !l.msg.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  React.useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  });

  const counts = LOG_LINES.reduce((a, l) => ((a[l.lvl] = (a[l.lvl] || 0) + 1), a), {});

  return (
    <section className="logs">
      <header className="logs-head">
        <div className="logs-head-left">
          <span className="logs-title">
            <Icons.Activity size={14} />
            Logs
          </span>
          <span className="logs-file">project-pgtable-docs.log</span>
        </div>

        <div className="logs-head-right">
          <div className="log-filter-tabs">
            {["all", "info", "warn", "err"].map(k => (
              <button
                key={k}
                className={`tab ${filter === k ? "active" : ""}`}
                onClick={() => setFilter(k)}
              >
                {k === "all" ? "All" : k === "info" ? "Info" : k === "warn" ? "Warnings" : "Errors"}
                {k !== "all" && counts[k] != null && <span className="tab-count">{counts[k]}</span>}
                {k === "all" && <span className="tab-count">{LOG_LINES.length}</span>}
              </button>
            ))}
          </div>
          <div className="log-search">
            <Icons.Search size={11} />
            <input
              placeholder="Filter logs"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <label className="toggle">
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
            <span className="toggle-track"><span className="toggle-thumb" /></span>
            <span className="toggle-label">Auto-scroll</span>
          </label>
          <button className="ico-btn" title="Clear"><Icons.Trash size={14}/></button>
        </div>
      </header>

      <div className="logs-body scroll" ref={scrollRef}>
        {filtered.map((l, i) => <LogLine key={i} line={l} n={String(i + 1).padStart(3, "0")} />)}
        {filtered.length === 0 && <div className="logs-empty">No log lines match.</div>}
        <div className="logs-tail">
          <span className="tail-cursor" />
          <span className="tail-text">waiting for new output…</span>
        </div>
      </div>
    </section>
  );
};

const MainPanel = ({ service }) => (
  <main className="main">
    <ServiceHero s={service} />
    <MetricStrip s={service} />
    <TerminalArea />
  </main>
);

const MainStyles = () => (
  <style>{`
    .main {
      flex: 1; min-width: 0;
      position: relative;
      background: var(--panel-bg);
      display: flex; flex-direction: column;
      min-height: 0;
      overflow-y: auto;
      padding: 22px 26px 16px;
      gap: 16px;
    }

    /* ---- hero ---- */
    .hero {
      display: flex; flex-direction: column; gap: 16px;
    }
    .hero-top { display: flex; align-items: flex-start; gap: 16px; }

    .hero-id { display: flex; align-items: center; gap: 14px; }
    .hero-icon {
      width: 44px; height: 44px;
      border-radius: 12px;
      background: var(--accent-tint);
      border: 1px solid var(--accent-tint-bot);
      color: var(--accent);
      display: inline-flex; align-items: center; justify-content: center;
    }
    .hero-id-text { display: flex; flex-direction: column; gap: 2px; }
    .hero-status-row {
      display: inline-flex; align-items: center; gap: 7px;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
    }
    .hero-status-label { color: var(--success); font-weight: 500; letter-spacing: 0.04em; text-transform: uppercase; }
    .hero-uptime { color: var(--text-dim); }
    .hero-name {
      font-size: 26px;
      font-weight: 600;
      letter-spacing: -0.02em;
      margin: 0;
      display: inline-flex; align-items: center; gap: 14px;
      color: var(--text);
    }
    .hero-branch {
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 500;
      color: var(--text-muted);
      background: var(--chip-bg);
      border: 1px solid var(--border-soft);
      padding: 3px 8px;
      border-radius: 999px;
      display: inline-flex; align-items: center; gap: 4px;
      letter-spacing: 0;
    }
    .hero-top-actions { margin-left: auto; display: flex; gap: 4px; }

    .hero-url-row {
      display: flex; align-items: center; gap: 12px;
      flex-wrap: wrap;
    }
    .url-chip {
      position: relative;
      display: inline-flex; align-items: center; gap: 10px;
      padding: 9px 12px 9px 14px;
      background: var(--card-bg);
      border: 1px solid var(--border-soft);
      border-radius: 999px;
      color: var(--text);
      font-family: var(--font-mono);
      font-size: 12.5px;
      transition: all .14s;
    }
    .url-chip svg:first-child { color: var(--accent); }
    .url-chip:hover { border-color: var(--border-strong); background: var(--card-bg-hover); }
    .url-chip .url-copy { color: var(--text-dim); }
    .url-chip .url-copied-badge {
      position: absolute; top: -22px; left: 50%; transform: translateX(-50%);
      background: var(--text); color: var(--window-bg);
      font-family: var(--font-sans);
      font-size: 10.5px; font-weight: 500;
      padding: 3px 8px; border-radius: 4px;
      white-space: nowrap;
    }

    .hero-actions {
      display: inline-flex; align-items: center; gap: 4px;
      margin-left: auto;
    }
    .actions-divider {
      width: 1px; height: 18px; margin: 0 6px;
      background: var(--border);
    }

    .btn {
      display: inline-flex; align-items: center; gap: 7px;
      padding: 8px 13px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 12.5px;
      font-weight: 500;
      transition: all .14s;
      box-shadow: var(--shadow-inset);
    }
    .btn:hover { background: var(--card-bg-hover); border-color: var(--border-strong); }
    .btn.danger {
      color: var(--danger);
      background: var(--danger-tint);
      border-color: var(--danger-tint-bot);
    }
    .btn.danger:hover { filter: brightness(1.08); }
    .btn.primary {
      background: var(--accent);
      color: var(--accent-fg);
      border-color: var(--accent);
    }

    /* ---- metric strip ---- */
    .metric-strip {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 10px;
    }
    .metric {
      background: var(--card-bg);
      border: 1px solid var(--border-soft);
      border-radius: 12px;
      padding: 11px 13px 12px;
      display: flex; flex-direction: column; gap: 4px;
      min-width: 0;
      box-shadow: var(--shadow-inset);
    }
    .metric-label {
      font-family: var(--font-mono);
      font-size: 9.5px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--text-faint);
      font-weight: 500;
    }
    .metric-value-row {
      display: flex; align-items: center; justify-content: space-between;
      gap: 10px;
    }
    .metric-value {
      font-family: var(--font-mono);
      font-size: 19px;
      font-weight: 500;
      letter-spacing: -0.01em;
      color: var(--text);
    }
    .metric-unit {
      font-size: 11px;
      color: var(--text-dim);
      margin-left: 2px;
      font-weight: 400;
    }
    .metric-sub {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-faint);
    }
    .metric-code {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: block;
      letter-spacing: -0.01em;
    }
    .mem-stack { width: 100%; max-width: 86px; }
    .mem-bar {
      width: 100%;
      height: 6px;
      background: var(--accent-tint);
      border-radius: 99px;
      overflow: hidden;
    }
    .mem-bar-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--accent), oklch(from var(--accent) calc(l + 0.05) c h));
      border-radius: 99px;
      transition: width .3s;
    }

    /* ---- logs ---- */
    .logs {
      flex: 1; min-height: 0;
      display: flex; flex-direction: column;
      background: var(--card-bg);
      border: 1px solid var(--border-soft);
      border-bottom: 0;
      border-radius: 14px 14px 0 0;
      overflow: hidden;
      box-shadow: var(--shadow-inset);
    }
    .logs-head {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border-soft);
      background: var(--titlebar-bg);
      flex-wrap: wrap;
    }
    .logs-head-left { display: inline-flex; align-items: center; gap: 12px; }
    .logs-title {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 12.5px; font-weight: 500;
      color: var(--text);
    }
    .logs-title svg { color: var(--accent); }
    .logs-file {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-dim);
      background: var(--card-bg);
      border: 1px solid var(--border-soft);
      padding: 2px 7px;
      border-radius: 5px;
    }

    .logs-head-right { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; }

    .log-filter-tabs {
      display: inline-flex;
      background: var(--input-bg);
      border: 1px solid var(--border-soft);
      border-radius: 8px;
      padding: 2px;
    }
    .log-filter-tabs .tab {
      padding: 4px 10px;
      background: transparent;
      border: 0;
      border-radius: 6px;
      color: var(--text-dim);
      font-size: 11.5px;
      font-weight: 500;
      display: inline-flex; align-items: center; gap: 5px;
      transition: all .12s;
    }
    .log-filter-tabs .tab:hover { color: var(--text); }
    .log-filter-tabs .tab.active {
      background: var(--card-bg);
      color: var(--text);
      box-shadow: var(--shadow-inset);
    }
    .tab-count {
      font-family: var(--font-mono);
      font-size: 9.5px;
      padding: 1px 5px;
      background: var(--chip-bg);
      border-radius: 3px;
      color: var(--text-faint);
    }
    .log-filter-tabs .tab.active .tab-count { color: var(--text-muted); }

    .log-search {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 0 9px;
      height: 28px;
      background: var(--input-bg);
      border: 1px solid var(--border-soft);
      border-radius: 7px;
      color: var(--text-dim);
    }
    .log-search input {
      background: transparent; border: 0; outline: none;
      color: var(--text); font: inherit; font-size: 12px;
      width: 110px;
    }

    .toggle {
      display: inline-flex; align-items: center; gap: 7px;
      font-size: 11.5px;
      color: var(--text-muted);
      cursor: pointer;
    }
    .toggle input { position: absolute; opacity: 0; pointer-events: none; }
    .toggle-track {
      width: 28px; height: 16px; border-radius: 99px;
      background: var(--chip-bg);
      border: 1px solid var(--border);
      position: relative; transition: background .14s;
    }
    .toggle-thumb {
      position: absolute; top: 1px; left: 1px;
      width: 12px; height: 12px; border-radius: 50%;
      background: var(--text-dim);
      transition: transform .18s ease, background .14s;
    }
    .toggle input:checked + .toggle-track { background: var(--accent); border-color: var(--accent); }
    .toggle input:checked + .toggle-track .toggle-thumb { transform: translateX(12px); background: white; }
    .toggle-label { color: var(--text); font-weight: 500; }

    .logs-body {
      flex: 1; min-height: 0;
      padding: 6px 0 4px;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.55;
      background:
        linear-gradient(180deg, var(--card-bg), oklch(from var(--card-bg) calc(l - 0.005) c h));
    }
    .log-line {
      display: grid;
      grid-template-columns: 44px 92px 56px 1fr;
      gap: 10px;
      padding: 1px 14px 1px 0;
      color: var(--text);
      align-items: baseline;
    }
    .log-line:hover { background: var(--card-bg-hover); }
    .log-gutter {
      text-align: right;
      color: var(--text-faint);
      font-size: 10.5px;
      user-select: none;
    }
    .log-time {
      color: var(--text-dim);
      font-size: 11px;
      letter-spacing: -0.02em;
    }
    .log-badge {
      display: inline-flex; align-items: center; justify-content: center;
      padding: 0 6px;
      height: 16px;
      border: 1px solid;
      border-radius: 4px;
      font-size: 9.5px;
      font-weight: 600;
      letter-spacing: 0.06em;
      width: fit-content;
    }
    .log-badge.lvl-cmd { background: var(--accent-tint); border-color: var(--accent-tint-bot); color: var(--accent); }
    .log-badge.lvl-info { background: var(--info-tint); border-color: var(--info-tint-bot); color: var(--info); }
    .log-badge.lvl-vite { background: var(--magenta-tint); border-color: var(--magenta-tint-bot); color: var(--magenta); }
    .log-badge.lvl-warn { background: var(--warning-tint); border-color: var(--warning-tint-bot); color: var(--warning); }
    .log-badge.lvl-err { background: var(--danger-tint); border-color: var(--danger-tint-bot); color: var(--danger); }
    .log-msg {
      color: var(--text);
      white-space: pre-wrap; word-break: break-word;
    }
    .log-line.lvl-err .log-msg { color: var(--danger); }
    .log-line.lvl-warn .log-msg { color: var(--warning); }
    .log-line.lvl-cmd .log-msg { color: var(--accent); font-weight: 500; }

    .log-url { color: var(--info); text-decoration: underline; text-underline-offset: 2px; text-decoration-color: oklch(from var(--info) l c h / 0.4); }
    .log-path { color: var(--text-muted); }
    .log-num { color: var(--success); }
    .log-tag { color: var(--magenta); }
    .log-paren { color: var(--text-dim); }

    .logs-tail {
      padding: 8px 14px 12px 56px;
      display: inline-flex; align-items: center; gap: 8px;
      color: var(--text-faint);
      font-size: 11px;
    }
    .tail-cursor {
      display: inline-block; width: 7px; height: 13px;
      background: var(--accent);
      animation: blink 1.1s steps(2,start) infinite;
    }
    @keyframes blink { to { opacity: 0; } }
    .logs-empty {
      padding: 40px;
      text-align: center;
      color: var(--text-faint);
      font-family: var(--font-sans);
    }

    @media (max-width: 1280px) {
      .metric-strip { grid-template-columns: repeat(4, 1fr); }
      .metric:nth-child(6), .metric:nth-child(7) { grid-column: span 2; }
    }
  `}</style>
);

window.MainPanel = MainPanel;
window.MainStyles = MainStyles;
