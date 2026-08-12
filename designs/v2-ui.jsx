/* Matisa 2 — shared primitives */

Object.assign(window.Icons, {
  Home: (p) => <Icon {...p} d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1v-8.5Z" />,
  PanelClose: (p) => <Icon {...p} d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm12 0v14M8 9l-2 3 2 3" />,
  PanelOpen: (p) => <Icon {...p} d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm12 0v14M6 9l2 3-2 3" />,
  Key: (p) => <Icon {...p} d="M15.5 3a5.5 5.5 0 1 0-2.4 10.4L11 15.5H8.5V18H6v2.5H3v-3l8.1-8.1A5.5 5.5 0 0 1 15.5 3Zm1 4h.01" />,
  Eye: (p) => <Icon {...p} d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12S18 18.5 12 18.5 2.5 12 2.5 12Zm9.5 2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />,
  EyeOff: (p) => <Icon {...p} d="M4 4l16 16M9.9 5.9A9.8 9.8 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.5M6.3 8.2A16.7 16.7 0 0 0 2.5 12S6 18.5 12 18.5a9.6 9.6 0 0 0 3.3-.6" />,
  Warn: (p) => <Icon {...p} d="M12 4.5 21 19.5H3L12 4.5Zm0 5.5v4.5m0 2.5h.01" />,
  Clock: (p) => <Icon {...p} d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v5l3.5 2" />,
  Bolt: (p) => <Icon {...p} d="M13 3 5 13.5h5L10.5 21 19 10h-5.5L13 3Z" />,
  Pencil: (p) => <Icon {...p} d="M4 20h4L20 8l-4-4L4 16v4Zm11-13 4 4" />,
  Skull: (p) => <Icon {...p} d="M6 11a6 6 0 1 1 12 0v3l-1.5 1v2.5a1.5 1.5 0 0 1-1.5 1.5H9a1.5 1.5 0 0 1-1.5-1.5V15L6 14v-3Zm3.5 0h.01m5 0h.01" />,
  Command: (p) => <Icon {...p} d="M9 6a2.5 2.5 0 1 0-2.5 2.5H9m0 0v7m0-7h6m0 0h2.5A2.5 2.5 0 1 0 15 6v2.5m0 7H9m6 0v-7m0 7v2.5A2.5 2.5 0 1 0 17.5 15.5H15m-6 0H6.5A2.5 2.5 0 1 0 9 18v-2.5Z" />,
});

const TONE = { running: "mint", errored: "coral", stopped: "dim", starting: "amber" };

const Dot = ({ status, size = 7, pulse }) => (
  <span className={`dot tone-${TONE[status] || "dim"} ${pulse && status === "running" ? "pulse" : ""}`} style={{ width: size, height: size }} />
);

const Btn = ({ children, tone = "quiet", size = "md", ...rest }) => (
  <button className={`btn tone-${tone} sz-${size}`} {...rest}>{children}</button>
);

const IconBtn = ({ icon: I, label, active, tone, ...rest }) => (
  <button className={`ibtn ${active ? "is-active" : ""} ${tone ? `ib-${tone}` : ""}`} title={label} aria-label={label} {...rest}>
    <I size={15} />
  </button>
);

const Card = ({ title, count, meta, actions, children, className = "", pad = true, flex }) => (
  <section className={`card ${className}`} style={flex ? { flex: 1, minHeight: 0 } : undefined}>
    {(title || actions) && (
      <header className="card-head">
        <h2 className="card-title serif">{title}</h2>
        {count != null && <span className="card-count mono">{count}</span>}
        {meta && <span className="card-meta mono">{meta}</span>}
        <div className="card-actions">{actions}</div>
      </header>
    )}
    <div className={`card-body ${pad ? "" : "flush"}`}>{children}</div>
  </section>
);

const Sparkline = ({ data, color = "var(--lav)", w = 120, h = 30 }) => {
  const max = Math.max(...data, 1), step = w / (data.length - 1);
  const pts = data.map((v, i) => [i * step, h - (v / max) * (h - 5) - 2.5]);
  const line = pts.map((p, i) => (i ? `L${p[0].toFixed(1)},${p[1].toFixed(1)}` : `M${p[0]},${p[1].toFixed(1)}`)).join(" ");
  const id = React.useMemo(() => "sp" + Math.random().toString(36).slice(2, 7), []);
  return (
    <svg width={w} height={h} style={{ display: "block", overflow: "visible" }}>
      <defs><linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stopColor={color} stopOpacity="0.3" /><stop offset="100%" stopColor={color} stopOpacity="0" />
      </linearGradient></defs>
      <path d={`${line} L${w},${h} L0,${h} Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
};

const Meter = ({ value, max, color = "var(--lav)" }) => (
  <div className="meter"><div className="meter-fill" style={{ width: `${Math.min(100, (value / max) * 100)}%`, background: color }} /></div>
);

const UIStyles = () => (
  <style>{`
.dot{border-radius:50%;flex:none;display:inline-block;background:currentColor}
.tone-mint{color:var(--mint)}.tone-coral{color:var(--coral)}.tone-amber{color:var(--amber)}.tone-dim{color:var(--faint)}
.dot.pulse{box-shadow:0 0 0 0 currentColor;animation:dotpulse 2.4s ease-out infinite}
@keyframes dotpulse{0%{box-shadow:0 0 0 0 oklch(0.84 0.11 158/0.5)}70%{box-shadow:0 0 0 6px oklch(0.84 0.11 158/0)}100%{box-shadow:0 0 0 0 oklch(0.84 0.11 158/0)}}

.btn{display:inline-flex;align-items:center;gap:7px;border-radius:999px;font-size:12.5px;font-weight:500;white-space:nowrap;transition:background .15s,color .15s,box-shadow .15s,opacity .15s}
.btn.sz-md{height:34px;padding:0 16px}
.btn.sz-sm{height:27px;padding:0 12px;font-size:11.5px}
.btn.tone-primary{background:var(--lav);color:var(--lav-ink)}
.btn.tone-primary:hover{filter:brightness(1.06)}
.btn.tone-quiet{background:var(--surface-2);color:var(--text)}
.btn.tone-quiet:hover{background:var(--line)}
.btn.tone-ghost{color:var(--muted);box-shadow:inset 0 0 0 1px var(--line-soft)}
.btn.tone-ghost:hover{color:var(--text);box-shadow:inset 0 0 0 1px var(--line)}
.btn.tone-danger{background:var(--coral-wash);color:var(--coral)}
.btn.tone-danger:hover{background:var(--coral);color:var(--canvas)}
.btn.tone-dashed{color:var(--dim);box-shadow:inset 0 0 0 1px var(--line-soft);border-radius:10px}
.btn.tone-dashed:hover{color:var(--text)}

.ibtn{width:30px;height:30px;border-radius:9px;display:inline-grid;place-items:center;color:var(--dim);transition:all .14s}
.ibtn:hover{color:var(--text);background:var(--surface-2)}
.ibtn.is-active{color:var(--text);background:var(--surface-2)}
.ibtn.ib-danger:hover{color:var(--coral);background:var(--coral-wash)}
.ibtn.ib-go:hover{color:var(--mint);background:var(--mint-wash)}

.card{background:var(--surface);border-radius:16px;box-shadow:var(--shadow);display:flex;flex-direction:column;min-width:0}
.card-head{display:flex;align-items:center;gap:9px;padding:14px 16px 0}
.card-title{font-size:19px;margin:0;line-height:1.1;color:var(--text)}
.card-count{font-size:10px;color:var(--faint);background:var(--surface-2);border-radius:999px;padding:2px 7px;letter-spacing:0.02em;white-space:nowrap}
.card-meta{font-size:10.5px;color:var(--faint);letter-spacing:0.01em;white-space:nowrap}
.card-actions{margin-left:auto;display:flex;align-items:center;gap:4px}
.card-body{padding:12px 16px 16px;min-height:0;display:flex;flex-direction:column}
.card-body.flush{padding:0}

.meter{height:4px;border-radius:99px;background:var(--surface-2);overflow:hidden}
.meter-fill{height:100%;border-radius:99px;transition:width .3s}

.kbd{font-family:var(--mono);font-size:9.5px;color:var(--faint);background:var(--surface-2);border-radius:5px;padding:2px 5px;letter-spacing:0.02em}
  `}</style>
);

Object.assign(window, { TONE, Dot, Btn, IconBtn, Card, Sparkline, Meter, UIStyles });
