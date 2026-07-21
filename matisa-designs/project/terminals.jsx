/* Tiling terminal system — drag to dock, resize, fullscreen */

let __nid = 0;
const genId = () => `n${++__nid}`;

/* ---------- tree helpers (immutable) ---------- */
function removePane(node, termId) {
  if (!node) return null;
  if (node.type === "pane") return node.termId === termId ? null : node;
  const c0 = removePane(node.children[0], termId);
  const c1 = removePane(node.children[1], termId);
  if (!c0) return c1;
  if (!c1) return c0;
  return { ...node, children: [c0, c1] };
}
function insertBeside(node, targetTermId, newPane, dir, before) {
  if (node.type === "pane") {
    if (node.termId === targetTermId) {
      return { id: genId(), type: "split", dir, sizes: [50, 50], children: before ? [newPane, node] : [node, newPane] };
    }
    return node;
  }
  return { ...node, children: node.children.map(c => insertBeside(c, targetTermId, newPane, dir, before)) };
}
function updateSizes(node, splitId, sizes) {
  if (node.type === "pane") return node;
  if (node.id === splitId) return { ...node, sizes };
  return { ...node, children: node.children.map(c => updateSizes(c, splitId, sizes)) };
}
function collectTermIds(node, acc = []) {
  if (!node) return acc;
  if (node.type === "pane") { acc.push(node.termId); return acc; }
  collectTermIds(node.children[0], acc);
  collectTermIds(node.children[1], acc);
  return acc;
}
function zoneFromEvent(e, el) {
  const r = el.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width;
  const fy = (e.clientY - r.top) / r.height;
  const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
  return Object.keys(d).reduce((a, b) => (d[b] < d[a] ? b : a));
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ---------- log tokenizer ---------- */
function tokenize(msg) {
  return msg.split(/(https?:\/\/[^\s]+)/g).map((piece, i) => {
    if (/^https?:\/\//.test(piece)) return <span key={i} className="tok-url">{piece}</span>;
    return piece.split(/(\b\d+(?:\.\d+)?(?:ms|s|MB|kb)?\b)/g).map((sub, j) => {
      if (/^\d+(?:\.\d+)?(?:ms|s|MB|kb)?$/.test(sub)) return <span key={`${i}-${j}`} className="tok-num">{sub}</span>;
      return sub.split(/(\([^)]+\)|'[^']+')/g).map((bit, k) => {
        if (/^\(.+\)$/.test(bit)) return <span key={`${i}-${j}-${k}`} className="tok-paren">{bit}</span>;
        if (/^'.+'$/.test(bit)) return <span key={`${i}-${j}-${k}`} className="tok-str">{bit}</span>;
        return bit;
      });
    });
  });
}

const TermCtx = React.createContext(null);

/* ---------- one line ---------- */
const TermLine = ({ line }) => {
  if (line.lvl === "spacer") return <div className="tl-spacer" />;
  return (
    <div className={`tl ${line.indent ? "indent" : ""} lvl-${line.lvl}`}>
      {line.t && <span className="tl-time">{line.t}</span>}
      <span className="tl-msg">
        {line.lvl === "warn" && line.msg.startsWith("Warning") ? (
          <>
            <span className="tl-warnbadge">Warning</span>
            {tokenize(line.msg.slice(7))}
          </>
        ) : tokenize(line.msg)}
      </span>
    </div>
  );
};

/* ---------- a terminal pane ---------- */
const TerminalPane = ({ term, fullscreen }) => {
  const ctx = React.useContext(TermCtx);
  const [autoScroll, setAutoScroll] = React.useState(true);
  const bodyRef = React.useRef(null);

  React.useEffect(() => {
    if (autoScroll && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  });

  const drag = !fullscreen;
  const dropSide = ctx.drop && ctx.drop.termId === term.id && ctx.dragId && ctx.dragId !== term.id
    ? ctx.drop.side : null;
  const isDragging = ctx.dragId === term.id;

  return (
    <div
      className={`term ${isDragging ? "dragging" : ""}`}
      onDragOver={drag ? (e) => {
        if (!ctx.dragId || ctx.dragId === term.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        ctx.setDrop({ termId: term.id, side: zoneFromEvent(e, e.currentTarget) });
      } : undefined}
      onDrop={drag ? (e) => {
        e.preventDefault();
        ctx.performDrop(term.id, zoneFromEvent(e, e.currentTarget));
      } : undefined}
    >
      <header
        className="term-head"
        draggable={drag}
        onDragStart={drag ? (e) => {
          ctx.setDragId(term.id);
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", term.id);
        } : undefined}
        onDragEnd={drag ? () => { ctx.setDragId(null); ctx.setDrop(null); } : undefined}
      >
        {drag && <span className="term-grip" title="Drag to rearrange"><Icons.Grip size={14} /></span>}
        <span className="term-title">{term.title}</span>
        <span className="term-status">
          <StatusDot status={term.status} size={6} />
          <span className="file-label">{term.file}</span>
        </span>
        <span className="term-spacer" />
        <label className="toggle term-toggle">
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
          <span className="toggle-track"><span className="toggle-thumb" /></span>
          <span className="toggle-label">Auto-scroll</span>
        </label>
        <button className="ico" title="Clear"><Icons.Trash size={13} /></button>
        <button className="ico" title={fullscreen ? "Exit fullscreen" : "Fullscreen"} onClick={() => ctx.setFull(fullscreen ? null : term.id)}>
          {fullscreen ? <Icons.Minimize size={13} /> : <Icons.Maximize size={13} />}
        </button>
        {!fullscreen && ctx.canClose && (
          <button className="ico danger-hover" title="Close terminal" onClick={() => ctx.closeTerminal(term.id)}><Icons.X size={13} /></button>
        )}
      </header>

      <div className="term-body scroll" ref={bodyRef}>
        {term.lines.map((l, i) => <TermLine key={i} line={l} />)}
        <div className="term-tail"><span className="tail-cursor" /></div>
      </div>

      {dropSide && <div className={`drop-hl side-${dropSide}`} />}
    </div>
  );
};

/* ---------- split container with resize ---------- */
const SplitContainer = ({ node }) => {
  const ctx = React.useContext(TermCtx);
  const ref = React.useRef(null);
  const horizontal = node.dir === "row";

  const onDown = (e) => {
    e.preventDefault();
    const rect = ref.current.getBoundingClientRect();
    const total = horizontal ? rect.width : rect.height;
    const start = horizontal ? e.clientX : e.clientY;
    const s0 = node.sizes[0];
    const move = (ev) => {
      const cur = horizontal ? ev.clientX : ev.clientY;
      const delta = ((cur - start) / total) * 100;
      const n0 = clamp(s0 + delta, 14, 86);
      ctx.onResize(node.id, [n0, 100 - n0]);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div className={`split ${horizontal ? "row" : "col"}`} ref={ref}>
      <div className="split-cell" style={{ flexBasis: `${node.sizes[0]}%` }}>{renderNode(node.children[0])}</div>
      <div className={`divider ${horizontal ? "v" : "h"}`} onMouseDown={onDown}><span className="divider-grip" /></div>
      <div className="split-cell" style={{ flexBasis: `${node.sizes[1]}%` }}>{renderNode(node.children[1])}</div>
    </div>
  );
};

function renderNode(node) {
  if (!node) return null;
  if (node.type === "pane") {
    const term = TERMINALS.find(t => t.id === node.termId);
    if (!term) return null;
    return <TerminalPane key={node.termId} term={term} />;
  }
  return <SplitContainer key={node.id} node={node} />;
}

/* ---------- the whole area ---------- */
const TerminalArea = () => {
  const [tree, setTree] = React.useState(() => ({
    id: genId(), type: "split", dir: "row", sizes: [50, 50],
    children: [{ id: "server", type: "pane", termId: "server" }, { id: "studio", type: "pane", termId: "studio" }],
  }));
  const [dragId, setDragId] = React.useState(null);
  const [drop, setDrop] = React.useState(null);
  const [full, setFull] = React.useState(null);

  const shown = collectTermIds(tree);
  const available = TERMINALS.filter(t => !shown.includes(t.id));

  const performDrop = (targetId, side) => {
    if (!dragId || dragId === targetId) { setDrop(null); setDragId(null); return; }
    const removed = removePane(tree, dragId);
    const newPane = { id: dragId, type: "pane", termId: dragId };
    const dir = side === "left" || side === "right" ? "row" : "col";
    const before = side === "left" || side === "top";
    setTree(insertBeside(removed, targetId, newPane, dir, before));
    setDrop(null); setDragId(null);
  };
  const addTerminal = () => {
    if (!available.length) return;
    const t = available[0];
    setTree({ id: genId(), type: "split", dir: "row", sizes: [68, 32], children: [tree, { id: t.id, type: "pane", termId: t.id }] });
  };
  const closeTerminal = (termId) => {
    const r = removePane(tree, termId);
    if (!r) return;
    setTree(r);
    if (full === termId) setFull(null);
  };

  const ctxVal = { dragId, setDragId, drop, setDrop, performDrop, full, setFull, closeTerminal, canClose: shown.length > 1, onResize: (id, sizes) => setTree(t => updateSizes(t, id, sizes)) };
  const fullTerm = full ? TERMINALS.find(t => t.id === full) : null;

  return (
    <TermCtx.Provider value={ctxVal}>
      <div className="term-region">
        <div className="term-bar">
          <span className="term-bar-title"><Icons.Terminal size={13} /> Terminals</span>
          <span className="term-bar-count">{shown.length} open</span>
          <span className="term-spacer" />
          {available.length > 0 && (
            <button className="term-add" onClick={addTerminal}>
              <Icons.Plus size={13} /> Add terminal
            </button>
          )}
        </div>
        <div className="term-grid">{renderNode(tree)}</div>
        {fullTerm && (
          <div className="term-fullscreen">
            <TerminalPane term={fullTerm} fullscreen />
          </div>
        )}
      </div>
      <TerminalStyles />
    </TermCtx.Provider>
  );
};

const TerminalStyles = () => (
  <style>{`
    .term-region {
      flex: 1; min-height: 300px;
      display: flex; flex-direction: column;
      gap: 8px;
      padding-bottom: 0;
    }
    .term-bar {
      display: flex; align-items: center; gap: 10px;
      padding: 0 2px 2px;
    }
    .term-bar-title {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 12px; font-weight: 600; color: var(--text);
      letter-spacing: 0.01em;
    }
    .term-bar-title svg { color: var(--accent); }
    .term-bar-count {
      font-family: var(--font-mono); font-size: 10.5px;
      color: var(--text-faint);
      background: var(--card-bg); border: 1px solid var(--border-soft);
      padding: 1px 7px; border-radius: 999px;
    }
    .term-add {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 11px;
      background: var(--card-bg); border: 1px solid var(--border);
      border-radius: 8px; color: var(--text);
      font-size: 12px; font-weight: 500;
      transition: all .14s; box-shadow: var(--shadow-inset);
    }
    .term-add:hover { background: var(--card-bg-hover); border-color: var(--border-strong); }

    .term-grid { flex: 1; min-height: 0; display: flex; }
    .term-grid > * { flex: 1; min-width: 0; min-height: 0; }

    .split { display: flex; flex: 1; min-width: 0; min-height: 0; }
    .split.row { flex-direction: row; }
    .split.col { flex-direction: column; }
    .split-cell { display: flex; flex-grow: 0; flex-shrink: 0; min-width: 0; min-height: 0; }
    .split-cell > * { flex: 1; min-width: 0; min-height: 0; }

    .divider {
      flex: 0 0 8px;
      display: flex; align-items: center; justify-content: center;
      position: relative; z-index: 2;
    }
    .divider.v { cursor: col-resize; }
    .divider.h { cursor: row-resize; }
    .divider-grip {
      background: transparent; border-radius: 99px;
      transition: background .14s;
    }
    .divider.v .divider-grip { width: 3px; height: 34px; }
    .divider.h .divider-grip { height: 3px; width: 34px; }
    .divider:hover .divider-grip { background: var(--accent); }

    .term {
      position: relative;
      flex: 1; min-width: 0; min-height: 0;
      display: flex; flex-direction: column;
      background: var(--card-bg);
      border: 1px solid var(--border-soft);
      border-radius: 12px;
      overflow: hidden;
      box-shadow: var(--shadow-inset);
      container-type: inline-size;
    }
    .term.dragging { opacity: 0.4; }

    .term-head {
      display: flex; align-items: center; gap: 9px;
      padding: 7px 8px 7px 6px;
      border-bottom: 1px solid var(--border-soft);
      background: var(--titlebar-bg);
      flex-shrink: 0;
    }
    .term-head .ico { flex-shrink: 0; }
    .term-grip { flex-shrink: 0; }
    .term-grip {
      display: inline-flex; color: var(--text-faint); cursor: grab;
      padding: 2px;
    }
    .term-grip:active { cursor: grabbing; }
    .term-title {
      font-size: 12px; font-weight: 600; color: var(--text);
      letter-spacing: -0.005em;
      min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .term-status {
      display: inline-flex; align-items: center; gap: 6px;
      font-family: var(--font-mono); font-size: 10.5px;
      color: var(--text-dim);
      min-width: 0; overflow: hidden;
    }
    .term-status .file-label {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
    }
    .term-status .status-dot { flex-shrink: 0; }
    @container (max-width: 360px) {
      .term-status { display: none; }
    }
    @container (max-width: 300px) {
      .term-toggle { display: none; }
    }
    @container (max-width: 240px) {
      .term-head { gap: 5px; padding-left: 4px; }
      .term-grip { display: none; }
    }
    .term-spacer { flex: 1; }
    .term-toggle { margin-right: 2px; }
    .term-toggle .toggle-label { display: none; }
    @media (min-width: 1400px) { .term-toggle .toggle-label { display: inline; } }

    .term-body {
      flex: 1; min-height: 0;
      padding: 8px 12px 10px;
      font-family: var(--font-mono);
      font-size: 12px; line-height: 1.5;
      color: var(--text);
    }
    .tl { display: flex; gap: 10px; padding: 0.5px 0; white-space: pre-wrap; word-break: break-word; }
    .tl.indent { padding-left: 20px; }
    .tl-time { color: var(--text-faint); flex-shrink: 0; }
    .tl-time::before { content: "["; }
    .tl-time::after { content: "]"; }
    .tl-msg { min-width: 0; }
    .tl-spacer { height: 9px; }

    .tl.lvl-cmd .tl-msg { color: var(--magenta); font-weight: 500; }
    .tl.lvl-dim .tl-msg { color: var(--text-dim); }
    .tl.lvl-info .tl-msg { color: var(--text); }
    .tl.lvl-ok .tl-msg { color: var(--success); }
    .tl.lvl-warn .tl-msg { color: var(--warning); }
    .tl.lvl-err .tl-msg { color: var(--danger); }

    .tl-warnbadge {
      display: inline-block;
      background: var(--warning-tint); color: var(--warning);
      border: 1px solid var(--warning-tint-bot);
      padding: 0 6px; border-radius: 4px;
      font-weight: 600; font-size: 10.5px;
      margin-right: 6px;
    }

    .tok-url { color: var(--info); text-decoration: underline; text-underline-offset: 2px; text-decoration-color: oklch(from var(--info) l c h / 0.4); }
    .tok-num { color: var(--success); }
    .tok-paren { color: var(--text-dim); }
    .tok-str { color: var(--warning); }

    .term-tail { padding-top: 3px; }
    .tail-cursor {
      display: inline-block; width: 7px; height: 13px;
      background: var(--accent); vertical-align: middle;
      animation: blink 1.1s steps(2,start) infinite;
    }

    /* drop highlight */
    .drop-hl {
      position: absolute; z-index: 5; pointer-events: none;
      background: oklch(from var(--accent) l c h / 0.16);
      border: 2px solid var(--accent);
      border-radius: 10px;
      transition: all .1s ease;
    }
    .drop-hl.side-left { left: 4px; top: 4px; bottom: 4px; width: calc(50% - 6px); }
    .drop-hl.side-right { right: 4px; top: 4px; bottom: 4px; width: calc(50% - 6px); }
    .drop-hl.side-top { left: 4px; right: 4px; top: 4px; height: calc(50% - 6px); }
    .drop-hl.side-bottom { left: 4px; right: 4px; bottom: 4px; height: calc(50% - 6px); }

    /* fullscreen overlay covers the whole main panel */
    .term-fullscreen {
      position: absolute; inset: 0; z-index: 30;
      background: var(--panel-bg);
      padding: 16px;
      display: flex;
      animation: term-zoom .16s ease;
    }
    .term-fullscreen > * { flex: 1; }
    @keyframes term-zoom { from { opacity: 0; transform: scale(0.99); } to { opacity: 1; transform: none; } }
  `}</style>
);

window.TerminalArea = TerminalArea;
