/* Matisa 2 — board primitives */

Object.assign(window.Icons, {
  Home: (p) => <Icon {...p} d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1v-8.5Z" />,
  Key: (p) => <Icon {...p} d="M15.5 3a5.5 5.5 0 1 0-2.4 10.4L11 15.5H8.5V18H6v2.5H3v-3l8.1-8.1A5.5 5.5 0 0 1 15.5 3Zm1 4h.01" />,
  Eye: (p) => <Icon {...p} d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12S18 18.5 12 18.5 2.5 12 2.5 12Zm9.5 2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />,
  EyeOff: (p) => <Icon {...p} d="M4 4l16 16M9.9 5.9A9.8 9.8 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.5M6.3 8.2A16.7 16.7 0 0 0 2.5 12S6 18.5 12 18.5a9.6 9.6 0 0 0 3.3-.6" />,
  Warn: (p) => <Icon {...p} d="M12 4.5 21 19.5H3L12 4.5Zm0 5.5v4.5m0 2.5h.01" />,
  Skull: (p) => <Icon {...p} d="M6 11a6 6 0 1 1 12 0v3l-1.5 1v2.5a1.5 1.5 0 0 1-1.5 1.5H9a1.5 1.5 0 0 1-1.5-1.5V15L6 14v-3Zm3.5 0h.01m5 0h.01" />,
  Pencil: (p) => <Icon {...p} d="M4 20h4L20 8l-4-4L4 16v4Zm11-13 4 4" />,
  ChevronUp: (p) => <Icon {...p} d="M6 15l6-6 6 6" />,
  PanelClose: (p) => <Icon {...p} d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm12 0v14M8 9l-2 3 2 3" />,
  PanelOpen: (p) => <Icon {...p} d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm12 0v14M6 9l2 3-2 3" />,
  Grid: (p) => <Icon {...p} d="M4 5.5A1.5 1.5 0 0 1 5.5 4h4A1.5 1.5 0 0 1 11 5.5v4A1.5 1.5 0 0 1 9.5 11h-4A1.5 1.5 0 0 1 4 9.5v-4Zm9 0A1.5 1.5 0 0 1 14.5 4h4A1.5 1.5 0 0 1 20 5.5v4a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 13 9.5v-4Zm-9 9A1.5 1.5 0 0 1 5.5 13h4a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 9.5 20h-4A1.5 1.5 0 0 1 4 18.5v-4Zm9 0A1.5 1.5 0 0 1 14.5 13h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5v-4Z" />,
  Bolt: (p) => <Icon {...p} d="M13 3 5 13.5h5L10.5 21 19 10h-5.5L13 3Z" />,
});

const TONE = { running: "lav", errored: "coral", stopped: "idle", starting: "amber" };
const kindIcon = (s) => Icons[s.icon] || Icons.Code;

const Dot = ({ status, size = 6, pulse }) => (
  <span className={`dot d-${status} ${pulse && status === "running" ? "pulse" : ""}`} style={{ width: size, height: size }} />
);

const Btn = ({ children, tone = "quiet", size = "md", ...rest }) => (
  <button className={`btn t-${tone} s-${size}`} {...rest}>{children}</button>
);

const IconBtn = ({ icon: I, label, active, tone, size = 15, ...rest }) => (
  <button className={`ibtn ${active ? "on" : ""} ${tone ? "ib-" + tone : ""}`} title={label} aria-label={label} {...rest}><I size={size} /></button>
);

const Spark = ({ data, color, w = 84, h = 22 }) => {
  const max = Math.max(...data, 1), step = w / (data.length - 1);
  const pts = data.map((v, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)},${(h - (v / max) * (h - 3) - 1.5).toFixed(1)}`).join(" ");
  return <svg width={w} height={h} style={{ display: "block", overflow: "visible" }}><path d={pts} fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
};

const BoardUIStyles = () => (
  <style>{`
.dot{border-radius:50%;flex:none;display:inline-block}
.d-running{background:var(--lav)}.d-errored{background:var(--coral)}.d-stopped{background:var(--idle)}.d-starting{background:var(--amber)}
.dot.pulse{animation:dp 2.6s ease-out infinite}
@keyframes dp{0%{box-shadow:0 0 0 0 oklch(0.84 0.085 300/.55)}70%{box-shadow:0 0 0 7px oklch(0.84 0.085 300/0)}100%{box-shadow:0 0 0 0 oklch(0.84 0.085 300/0)}}

.btn{display:inline-flex;align-items:center;gap:8px;border-radius:999px;font-size:12.5px;font-weight:600;white-space:nowrap;transition:filter .15s,background .15s,color .15s,box-shadow .15s}
.btn.s-md{height:36px;padding:0 18px}
.btn.s-sm{height:28px;padding:0 13px;font-size:11.5px}
.btn.t-primary{background:var(--lav);color:var(--ink)}
.btn.t-primary:hover{filter:brightness(1.07)}
.btn.t-danger{background:var(--coral);color:var(--ink)}
.btn.t-danger:hover{filter:brightness(1.07)}
.btn.t-quiet{background:var(--raise);color:var(--text)}
.btn.t-quiet:hover{background:var(--raise-2)}
.btn.t-ghost{color:var(--muted);box-shadow:inset 0 0 0 1px var(--line)}
.btn.t-ghost:hover{color:var(--text);box-shadow:inset 0 0 0 1px var(--line-hi)}

.ibtn{width:32px;height:32px;border-radius:10px;display:inline-grid;place-items:center;color:var(--dim);transition:all .14s}
.ibtn:hover{color:var(--text);background:var(--raise)}
.ibtn.on{color:var(--text);background:var(--raise)}
.ibtn.ib-danger:hover{color:var(--coral);background:var(--coral-wash)}
.kbd{font-family:var(--mono);font-size:9.5px;color:var(--dim);background:var(--raise);border-radius:5px;padding:2px 5px}
  `}</style>
);

Object.assign(window, { TONE, kindIcon, Dot, Btn, IconBtn, Spark, BoardUIStyles });
