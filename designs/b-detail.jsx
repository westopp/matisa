/* Matisa 2 — service detail pane (matches app layout: hero, chips, environment, commands, terminals) */

const MetricChip = ({ label, value }) => (
  <span className="mchip"><span className="mchip-l mono">{label}</span><span className="mchip-v mono">{value}</span></span>
);

const Section = ({ icon: I, title, badge, tools, children, defaultOpen = true }) => {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <section className={`dsec ${open ? "" : "shut"}`}>
      <header className="dsec-head">
        <button className="dsec-toggle" onClick={() => setOpen(o => !o)}>
          <span className={`caret ${open ? "" : "shut"}`}><Icons.ChevronDown size={13} /></span>
          <I size={14} />
          <h3 className="dsec-title serif">{title}</h3>
        </button>
        {badge}
        <div className="dsec-tools">{tools}</div>
      </header>
      {open && <div className="dsec-body">{children}</div>}
    </section>
  );
};

const EnvSection = ({ service }) => {
  const sets = service.env === "base" ? ["base"] : ["base", service.env];
  const [tab, setTab] = React.useState(sets[sets.length - 1]);
  const [showAll, setShowAll] = React.useState(false);
  React.useEffect(() => { setTab(sets[sets.length - 1]); setShowAll(false); }, [service.id]);
  const vars = ENVS[tab] || [];
  return (
    <Section icon={Icons.Key} title="Environment"
      badge={<div className="envset">
        {sets.map(k => <button key={k} className={`epill mono ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>{k}<b>{(ENVS[k] || []).length}</b></button>)}
        <button className="epill add mono"><Icons.Plus size={10} /> add environment</button>
      </div>}
      tools={<>
        <Btn size="sm" tone="ghost" onClick={() => setShowAll(v => !v)}>{showAll ? <Icons.EyeOff size={12} /> : <Icons.Eye size={12} />} {showAll ? "Hide" : "Show all"}</Btn>
        <Btn size="sm" tone="ghost"><Icons.Plus size={12} /> Variable</Btn>
      </>}>
      <div className="evars">
        {vars.map(v => (
          <div className="evar" key={v.k}>
            <span className="evar-k mono">{v.k}</span>
            <span className="evar-v mono">{v.secret && !showAll ? "••••••••••••" : v.v}</span>
          </div>
        ))}
      </div>
    </Section>
  );
};

const CommandsSection = ({ service }) => (
  <Section icon={Icons.Terminal} title="Commands" badge={<span className="count mono">{service.commands.length}</span>}
    tools={<Btn size="sm" tone="ghost"><Icons.Plus size={12} /> Command</Btn>}>
    <div className="ctable">
      <div className="ctr chead"><span className="mono">name</span><span className="mono">command</span><span className="mono">env</span></div>
      {service.commands.map(c => (
        <div className="ctr" key={c.name}>
          <span className="cname"><button className="crun" title={`Run ${c.name}`}><Icons.Play size={11} /></button>{c.name}</span>
          <code className="ccmd mono">{c.cmd}</code>
          <span className="cenv">{c.env && <span className="epill mono on">{c.env}</span>}</span>
        </div>
      ))}
    </div>
  </Section>
);

const TerminalSection = ({ service }) => {
  const t = service.terminals[0];
  const [typed, setTyped] = React.useState("");
  const [extra, setExtra] = React.useState([]);
  const ref = React.useRef(null);
  React.useEffect(() => { setExtra([]); }, [service.id]);
  React.useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [extra, service.id]);
  const lines = [...t.lines, ...extra];
  return (
    <Section icon={Icons.Terminal} title="Terminals" badge={<span className="count mono">{t.status === "running" ? "1 open" : "idle"}</span>}
      tools={<><IconBtn icon={Icons.Plus} label="New terminal" size={14} /><IconBtn icon={Icons.Maximize} label="Fullscreen" size={14} /></>}>
      <div className="term">
        <div className="term-head">
          <span className="grip"><Icons.Grip size={13} /></span>
          <Dot status={t.status} size={5} pulse />
          <span className="term-name">{t.title}</span>
          <code className="term-cmd mono">{(lines.find(l => l.lvl === "cmd") || { msg: "" }).msg.replace(/^\$ /, "")}</code>
          <div className="term-acts">
            <IconBtn icon={Icons.Skull} label="Kill" size={13} />
            <IconBtn icon={t.status === "running" ? Icons.Stop : Icons.Play} label={t.status === "running" ? "Stop" : "Start"} size={13} />
            <IconBtn icon={Icons.Trash} label="Clear" size={13} onClick={() => setExtra([])} />
            <IconBtn icon={Icons.Maximize} label="Expand" size={13} />
          </div>
        </div>
        <div className="term-body scroll" ref={ref}>
          {lines.map((l, i) => (
            <div className={`tline lv-${l.lvl}`} key={i} style={l.indent ? { paddingLeft: 20 + l.indent * 18 } : undefined}>
              {l.t && <span className="tline-t">{l.t}</span>}<span className="tline-m">{l.msg}</span>
            </div>
          ))}
          <div className="tline tail"><span className="cursor" /><span className="tline-m">{t.status === "running" ? "streaming…" : "session closed"}</span></div>
        </div>
        <form className="term-in" onSubmit={(e) => { e.preventDefault(); if (!typed.trim()) return; setExtra(x => [...x, { lvl: "cmd", msg: `$ ${typed}` }, { lvl: "dim", msg: t.status === "running" ? "sent to session" : `${service.name} is not running` }]); setTyped(""); }}>
          <span className="prompt mono">›</span>
          <input value={typed} onChange={e => setTyped(e.target.value)} placeholder="run a command" />
        </form>
      </div>
    </Section>
  );
};

const Detail = ({ service, onToggle, showSidebarBtn, onShowSidebar }) => {
  const running = service.status === "running";
  const [copied, setCopied] = React.useState(false);
  const copy = (t) => { navigator.clipboard?.writeText(t); setCopied(true); setTimeout(() => setCopied(false), 1100); };
  return (
    <main className="detail scroll">
      <header className="dhero">
        <div className="dhero-l">
          {showSidebarBtn && <IconBtn icon={Icons.PanelOpen} label="Show sidebar  ⌘\" size={14} onClick={onShowSidebar} />}
          <span className={`davatar st-${service.status}`}>{React.createElement(kindIcon(service), { size: 22 })}</span>
          <div className="dhero-id">
            <div className={`dstatus s-${service.status}`}>
              {service.status === "errored" ? <Icons.Warn size={12} /> : <Dot status={service.status} size={6} pulse />}
              <span className="mono">{service.status}</span>
              <span className="dnote">{service.statusNote}</span>
            </div>
            <h1 className="dname serif">{service.name}<span className="dkind mono">{service.kind}</span></h1>
          </div>
        </div>
        <div className="dhero-r">
          <IconBtn icon={Icons.Pencil} label="Edit service" />
          <IconBtn icon={Icons.Folder} label="Open folder" />
        </div>
      </header>

      <div className="dbar">
        <div className="dbar-l">
          {service.url && (
            <button className="urlchip" onClick={() => copy(service.url)}>
              <Icons.Globe size={13} /><span className="mono">{service.url}</span>
              <span className="urlchip-c mono">{copied ? "copied" : <Icons.Copy size={11} />}</span>
            </button>
          )}
          <div className="mchips">
            <MetricChip label="port" value={service.port || "—"} />
            <MetricChip label="pid" value={service.pid || "—"} />
            <MetricChip label="cpu" value={`${service.cpu.toFixed(1)}%`} />
            <MetricChip label="mem" value={`${service.mem}MB`} />
          </div>
          <span className="pathchip"><span className="mchip-l mono">path</span><span className="mono">{service.path}</span></span>
        </div>
        <div className="dbar-r">
          <Btn tone={running ? "danger" : "primary"} size="sm" onClick={() => onToggle(service.id)}>
            {running ? <Icons.Stop size={10} /> : <Icons.Play size={11} />}{running ? "Stop" : "Start"}
          </Btn>
          <IconBtn icon={Icons.Restart} label="Restart" size={14} />
          <span className="vr" />
          <IconBtn icon={Icons.Compass} label="Open in browser" size={14} />
          <IconBtn icon={Icons.Code} label="Open in editor" size={14} />
          <IconBtn icon={Icons.Skull} label="Force quit" size={14} tone="danger" />
        </div>
      </div>

      <EnvSection service={service} />
      <CommandsSection service={service} />
      <TerminalSection service={service} />
    </main>
  );
};

const DetailStyles = () => (
  <style>{`
.detail{flex:1;min-width:0;min-height:0;background:var(--canvas);display:flex;flex-direction:column;gap:20px;padding:20px 26px 30px}
.detail>*{flex:none}
.dhero{display:flex;align-items:flex-start;gap:14px}
.dhero-l{display:flex;align-items:center;gap:14px;min-width:0}
.davatar{width:46px;height:46px;flex:none;border-radius:14px;display:grid;place-items:center;background:var(--raise);color:var(--muted)}
.davatar.st-running{background:var(--lav);color:var(--ink)}
.davatar.st-errored{background:var(--coral);color:var(--ink)}
.dhero-id{min-width:0}
.dstatus{display:flex;align-items:center;gap:7px;font-size:11.5px}
.dstatus .mono{font-size:9.5px;letter-spacing:0.16em;text-transform:uppercase}
.dstatus.s-running .mono,.dstatus.s-running svg{color:var(--lav)}
.dstatus.s-errored .mono,.dstatus.s-errored svg{color:var(--coral)}
.dstatus.s-stopped .mono{color:var(--dim)}
.dnote{color:var(--dim)}
.dname{margin:4px 0 0;font-size:38px;line-height:1;letter-spacing:-0.04em;display:flex;align-items:center;gap:12px}
.dkind{font-size:9.5px;letter-spacing:0.14em;text-transform:uppercase;color:var(--dim);background:var(--raise);border-radius:999px;padding:5px 10px}
.dhero-r{margin-left:auto;display:flex;gap:4px;flex:none}

.dbar{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap}
.dbar-l{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dbar-r{margin-left:auto;display:flex;align-items:center;gap:4px;flex:none}
.vr{width:1px;height:18px;background:var(--line);margin:0 5px}
.urlchip{display:inline-flex;align-items:center;gap:9px;height:34px;padding:0 12px;border-radius:11px;background:var(--raise);color:var(--text);transition:background .14s}
.urlchip:hover{background:var(--raise-2)}
.urlchip .mono{font-size:12.5px}
.urlchip svg:first-child{color:var(--ice)}
.urlchip-c{font-size:9.5px;color:var(--dim);display:inline-flex;align-items:center}
.mchips{display:flex;gap:6px;flex-wrap:wrap}
.mchip,.pathchip{display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 12px;border-radius:11px;background:var(--raise);min-width:0}
.mchip-l{font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:var(--dim)}
.mchip-v{font-size:12.5px}
.pathchip .mono:last-child{font-size:11.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:360px}

.dsec{background:var(--sheet);border-radius:18px;padding-bottom:2px;display:flex;flex-direction:column;min-height:0}
.dsec-head{display:flex;align-items:center;gap:10px;padding:12px 14px}
.dsec.shut .dsec-head{padding-bottom:12px}
.dsec-toggle{display:inline-flex;align-items:center;gap:9px;color:var(--muted)}
.dsec-toggle:hover{color:var(--text)}
.dsec-title{font-size:16px;margin:0;color:var(--text);letter-spacing:-0.03em}
.caret{display:grid;place-items:center;transition:transform .16s}
.caret.shut{transform:rotate(-90deg)}
.dsec-tools{margin-left:auto;display:flex;align-items:center;gap:5px}
.dsec-body{padding:0 14px 14px}
.count{font-size:10px;color:var(--dim);background:var(--raise);border-radius:999px;padding:3px 8px}

.envset{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.epill{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;font-size:10.5px;color:var(--dim);background:var(--raise)}
.epill b{font-weight:500;opacity:.7}
.epill.on{color:var(--ink);background:var(--lav)}
.epill.on b{opacity:.6}
.epill.add{color:var(--dim);background:none;box-shadow:inset 0 0 0 1px var(--line)}
.epill.add:hover{color:var(--text)}
.evars{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px 20px}
.evar{display:flex;align-items:center;gap:10px;min-width:0;padding:7px 10px;border-radius:10px;background:var(--raise)}
.evar-k{font-size:9.5px;letter-spacing:0.12em;text-transform:uppercase;color:var(--dim);flex:none;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.evar-v{font-size:11.5px;flex:1;min-width:0;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.ctable{display:flex;flex-direction:column}
.ctr{display:grid;grid-template-columns:170px minmax(0,1fr) 90px;align-items:center;gap:14px;padding:9px 8px;border-radius:10px}
.ctr:not(.chead):hover{background:var(--raise)}
.chead{padding:0 8px 8px}
.chead .mono{font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:var(--dim)}
.cname{display:flex;align-items:center;gap:10px;font-size:13px;font-weight:600;letter-spacing:-0.02em}
.crun{width:24px;height:24px;flex:none;border-radius:8px;display:grid;place-items:center;color:oklch(0.72 0.17 150);background:oklch(0.72 0.17 150/.14)}
.crun:hover{filter:brightness(1.15)}
.ccmd{font-size:11.5px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ctr:hover .ccmd{color:var(--muted)}

.term{border-radius:14px;overflow:hidden;background:var(--sunken);box-shadow:inset 0 0 0 1px var(--line)}
.term-head{display:flex;align-items:center;gap:9px;padding:8px 8px 8px 10px;border-bottom:1px solid var(--line)}
.grip{color:var(--dim);display:grid;place-items:center}
.term-name{font-size:12px;font-weight:600;letter-spacing:-0.02em}
.term-cmd{flex:1;min-width:0;font-size:11px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.term-acts{display:flex;align-items:center;gap:1px;flex:none}
.term-body{height:210px;overflow-y:auto;padding:10px 0 6px;font-family:var(--mono);font-size:11.5px;line-height:1.75}
.tline{display:flex;gap:12px;padding:0 16px 0 20px;color:var(--muted)}
.tline-t{flex:none;font-size:10.5px;color:var(--dim);letter-spacing:-0.02em}
.tline-m{white-space:pre-wrap;word-break:break-word;min-width:0}
.lv-cmd .tline-m{color:var(--lav)}
.lv-info .tline-m{color:var(--ice)}
.lv-ok .tline-m{color:var(--mint)}
.lv-warn .tline-m{color:var(--amber)}
.lv-err .tline-m{color:var(--coral)}
.lv-dim .tline-m{color:var(--dim)}
.tline.tail{align-items:center;padding-top:6px}
.tline.tail .tline-m{color:var(--dim)}
.cursor{width:6px;height:12px;background:var(--lav);animation:blink 1.15s steps(2,start) infinite}
@keyframes blink{to{opacity:0}}
.term-in{display:flex;align-items:center;gap:10px;height:38px;padding:0 14px 0 20px;border-top:1px solid var(--line)}
.prompt{color:var(--lav);font-size:12px}
.term-in input{flex:1;min-width:0;background:none;border:0;outline:none;color:var(--text);font-family:var(--mono);font-size:11.5px}
.term-in input::placeholder{color:var(--dim)}

@media (max-width:1180px){.dbar-r{margin-left:0}.ctr{grid-template-columns:130px minmax(0,1fr) 76px;gap:10px}.pathchip .mono:last-child{max-width:190px}}
  `}</style>
);

Object.assign(window, { Detail, DetailStyles, Section, MetricChip });
