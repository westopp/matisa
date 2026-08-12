/* Matisa 2 — terminal surface */

const LVL_TONE = { err: "coral", warn: "amber", ok: "mint", info: "ice", cmd: "lav", dim: "faint" };

const TLine = ({ l }) => (
  <div className={`tline lv-${l.lvl}`} style={l.indent ? { paddingLeft: 24 + l.indent * 18 } : undefined}>
    {l.t && <span className="tline-t">{l.t}</span>}
    <span className="tline-msg">{l.msg}</span>
  </div>
);

const TerminalCard = ({ service }) => {
  const terms = service.terminals;
  const [active, setActive] = React.useState(0);
  const [full, setFull] = React.useState(false);
  const [wrap, setWrap] = React.useState(true);
  const [typed, setTyped] = React.useState("");
  const [extra, setExtra] = React.useState([]);
  const bodyRef = React.useRef(null);
  React.useEffect(() => { setActive(0); setExtra([]); }, [service.id]);
  React.useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [extra, active, service.id]);

  const t = terms[Math.min(active, terms.length - 1)];
  const lines = [...t.lines, ...extra];
  const submit = (e) => {
    e.preventDefault();
    if (!typed.trim()) return;
    setExtra(x => [...x, { lvl: "cmd", msg: `$ ${typed}` }, { lvl: "dim", msg: `zsh: session is ${t.status === "running" ? "attached" : "not running"}` }]);
    setTyped("");
  };

  return (
    <section className={`term card ${full ? "is-full" : ""}`}>
      <header className="term-head">
        <div className="term-tabs">
          {terms.map((tt, i) => (
            <button key={tt.id} className={`term-tab ${i === active ? "on" : ""}`} onClick={() => setActive(i)}>
              <Dot status={tt.status} size={5} pulse />
              <span>{tt.title}</span>
            </button>
          ))}
          <button className="term-tab add" title="New terminal"><Icons.Plus size={12} /></button>
        </div>
        <div className="term-tools">
          <span className="term-file mono">{service.name}.log</span>
          <IconBtn icon={Icons.Filter} label="Wrap lines" active={wrap} onClick={() => setWrap(w => !w)} />
          <IconBtn icon={Icons.Trash} label="Clear output" onClick={() => setExtra([])} />
          <IconBtn icon={full ? Icons.Minimize : Icons.Maximize} label={full ? "Exit fullscreen" : "Fullscreen"} onClick={() => setFull(f => !f)} />
        </div>
      </header>
      <div className={`term-body scroll ${wrap ? "" : "nowrap"}`} ref={bodyRef}>
        {lines.map((l, i) => <TLine key={i} l={l} />)}
        <div className="tline tail"><span className="caret" /><span className="tline-msg">{t.status === "running" ? "streaming output…" : "session closed"}</span></div>
      </div>
      <form className="term-input" onSubmit={submit}>
        <span className="prompt mono">›</span>
        <input value={typed} onChange={e => setTyped(e.target.value)} placeholder={`run a command in ${t.title}`} />
        <span className="kbd">↵</span>
      </form>
    </section>
  );
};

const TerminalStyles = () => (
  <style>{`
.term{overflow:hidden;flex:1;min-height:0}
.term.is-full{position:absolute;inset:0;z-index:20;border-radius:18px}
.term-head{display:flex;align-items:center;gap:10px;padding:8px 10px 8px 12px;border-bottom:1px solid var(--line-soft)}
.term-tabs{display:flex;align-items:center;gap:2px;min-width:0;overflow:hidden}
.term-tab{display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 12px;border-radius:9px;font-size:12px;font-weight:500;color:var(--dim);transition:all .14s}
.term-tab:hover{color:var(--text);background:var(--surface-2)}
.term-tab.on{color:var(--text);background:var(--surface-2)}
.term-tab.add{padding:0 9px;color:var(--faint)}
.term-tools{margin-left:auto;display:flex;align-items:center;gap:3px}
.term-file{font-size:10.5px;color:var(--faint);margin-right:6px}

.term-body{flex:1;min-height:200px;background:var(--sunken);padding:12px 0 6px;font-family:var(--mono);font-size:11.5px;line-height:1.75}
.term-body.nowrap .tline-msg{white-space:pre}
.tline{display:flex;gap:12px;padding:0 16px 0 24px;color:var(--muted)}
.tline:hover{background:oklch(1 0 0/0.02)}
.tline-t{color:var(--faint);flex:none;font-size:10.5px;letter-spacing:-0.02em;padding-top:1px}
.tline-msg{white-space:pre-wrap;word-break:break-word;min-width:0}
.lv-cmd .tline-msg{color:var(--lav)}
.lv-info .tline-msg{color:var(--ice)}
.lv-ok .tline-msg{color:var(--mint)}
.lv-warn .tline-msg{color:var(--amber)}
.lv-err .tline-msg{color:var(--coral)}
.lv-dim .tline-msg{color:var(--faint)}
.tline.tail{color:var(--faint);align-items:center;padding-top:6px}
.tline.tail .tline-msg{color:var(--faint)}
.caret{width:6px;height:12px;background:var(--lav);animation:blink 1.15s steps(2,start) infinite}
@keyframes blink{to{opacity:0}}

.term-input{display:flex;align-items:center;gap:10px;height:40px;padding:0 14px 0 20px;background:var(--sunken);border-top:1px solid var(--line-soft)}
.prompt{color:var(--lav);font-size:13px}
.term-input input{flex:1;min-width:0;background:none;border:0;outline:none;color:var(--text);font-family:var(--mono);font-size:11.5px}
.term-input input::placeholder{color:var(--faint)}
  `}</style>
);

Object.assign(window, { TerminalCard, TerminalStyles });
