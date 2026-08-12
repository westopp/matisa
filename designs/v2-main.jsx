/* Matisa 2 — service detail */

const Stat = ({ label, value, unit, children, wide }) => (
  <div className={`stat ${wide ? "wide" : ""}`}>
    <div className="micro">{label}</div>
    <div className="stat-row">
      <span className="stat-val serif">{value}{unit && <span className="stat-unit mono">{unit}</span>}</span>
      {children}
    </div>
  </div>
);

const Incident = ({ inc, onStart }) => (
  <div className="incident">
    <span className="inc-ico"><Icons.Warn size={16} /></span>
    <div className="inc-text">
      <div className="inc-title serif">{inc.title}</div>
      <p className="inc-detail">{inc.detail}</p>
    </div>
    <div className="inc-acts">
      {inc.actions.map((a, i) => (
        <Btn key={a} size="sm" tone={i === 0 ? "primary" : "ghost"} onClick={i === 0 ? onStart : undefined}>{a}</Btn>
      ))}
    </div>
  </div>
);

const EnvCard = ({ service }) => {
  const sets = service.env === "base" ? ["base"] : ["base", service.env];
  const [tab, setTab] = React.useState(sets[sets.length - 1]);
  const [shown, setShown] = React.useState({});
  React.useEffect(() => { setTab(sets[sets.length - 1]); }, [service.id]);
  const vars = ENVS[tab] || [];
  return (
    <Card title="Environment" meta={`${vars.length} vars`} actions={<IconBtn icon={Icons.Plus} label="Add variable" />}>
      <div className="env-tabs">
        {sets.map(k => (
          <button key={k} className={`env-tab mono ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>
            <Icons.Key size={11} /> {k}
          </button>
        ))}
      </div>
      <div className="env-vars">
        {vars.map(v => (
          <div className="env-var" key={v.k}>
            <div className="env-krow">
              <span className="env-k mono">{v.k}</span>
              {v.secret && (
                <button className="env-reveal" title={shown[v.k] ? "Hide value" : "Reveal value"} onClick={() => setShown(s => ({ ...s, [v.k]: !s[v.k] }))}>
                  {shown[v.k] ? <Icons.EyeOff size={11} /> : <Icons.Eye size={11} />}
                </button>
              )}
            </div>
            <span className="env-v mono">{v.secret && !shown[v.k] ? "••••••••••••••••" : v.v}</span>
          </div>
        ))}
      </div>
    </Card>
  );
};

const CommandsCard = ({ service }) => (
  <Card title="Commands" count={service.commands.length} actions={<Btn size="sm" tone="ghost"><Icons.Plus size={12} /> Command</Btn>} pad={false}>
    <div className="cmds">
      {service.commands.map(c => (
        <div className={`cmd ${c.primary ? "is-primary" : ""}`} key={c.name}>
          <button className="cmd-run" title={`Run ${c.name}`}><Icons.Play size={10} /></button>
          <span className="cmd-name">{c.name}{c.primary && <span className="cmd-badge micro">default</span>}</span>
          <code className="cmd-code mono">{c.cmd}</code>
          {c.env && <span className="cmd-env mono">{c.env}</span>}
          <button className="cmd-more" title="Edit command"><Icons.More size={14} /></button>
        </div>
      ))}
    </div>
  </Card>
);

const QuickCard = ({ service }) => {
  const rows = [
    { icon: Icons.Compass, label: "Open in browser", key: "⌘O", off: !service.url },
    { icon: Icons.Code, label: "Open in editor", key: "⌘E" },
    { icon: Icons.Folder, label: "Reveal in Finder", key: "⇧⌘R" },
    { icon: Icons.Terminal, label: "New shell here", key: "⌘T" },
    { icon: Icons.Skull, label: "Force quit", key: "⌥⌘.", danger: true, off: service.status !== "running" },
  ];
  return (
    <Card title="Actions" pad={false}>
      <div className="quick">
        {rows.map(r => (
          <button key={r.label} className={`qrow ${r.danger ? "danger" : ""}`} disabled={r.off}>
            <r.icon size={14} /><span>{r.label}</span><span className="kbd">{r.key}</span>
          </button>
        ))}
      </div>
    </Card>
  );
};

const MainPanel = ({ service, onToggle }) => {
  const [copied, setCopied] = React.useState(false);
  const running = service.status === "running";
  const copy = () => { navigator.clipboard?.writeText(service.url || service.path); setCopied(true); setTimeout(() => setCopied(false), 1200); };

  return (
    <main className="main">
      <header className="head">
        <div className="crumbs mono">
          <span>matisa</span><Icons.ChevronRight size={10} /><span>{service.section}</span><Icons.ChevronRight size={10} /><span>{service.group}</span>
        </div>
        <div className="head-row">
          <span className={`head-ava tone-${TONE[service.status]}`}>{React.createElement(kindIcon(service), { size: 22 })}</span>
          <div className="head-id">
            <div className={`head-status tone-${TONE[service.status]}`}>
              <Dot status={service.status} size={6} pulse />
              <span className="hs-word mono">{service.status}</span>
              <span className="hs-note">{service.statusNote}</span>
            </div>
            <h1 className="head-name serif">{service.name}<span className="head-kind mono">{service.kind}</span></h1>
          </div>
          <div className="head-acts">
            <Btn tone={running ? "danger" : "primary"} onClick={() => onToggle(service.id)}>
              {running ? <Icons.Stop size={10} /> : <Icons.Play size={11} />}{running ? "Stop" : "Start"}
            </Btn>
            <IconBtn icon={Icons.Restart} label="Restart" />
            <IconBtn icon={Icons.Pencil} label="Edit service" />
            <IconBtn icon={Icons.More} label="More" />
          </div>
        </div>
        <div className="chips">
          {service.url && (
            <button className="chip link" onClick={copy}>
              <Icons.Globe size={12} /><span className="mono">{service.url}</span>
              <span className="chip-act">{copied ? "copied" : <Icons.Copy size={11} />}</span>
            </button>
          )}
          <button className="chip"><Icons.Folder size={12} /><span className="mono">{service.path}</span></button>
          <button className="chip"><Icons.Branch size={12} /><span className="mono">{service.env}</span><Icons.ChevronDown size={10} /></button>
        </div>
      </header>

      <div className="body scroll">
        {service.incident && service.status === "errored" && <Incident inc={service.incident} onStart={() => onToggle(service.id)} />}
        <div className="cols">
          <div className="col-a">
            <CommandsCard service={service} />
            <TerminalCard service={service} />
          </div>
          <aside className="col-b">
            <Card title="Vitals" meta={service.uptime !== "—" ? `up ${service.uptime}` : "idle"}>
              <div className="stats">
                <Stat label="Port" value={service.port || "—"} />
                <Stat label="PID" value={service.pid || "—"} />
                <Stat label="CPU" value={service.cpu.toFixed(1)} unit="%">
                  <Sparkline data={service.cpuSeries} w={92} h={28} color={running ? "var(--mint)" : "var(--faint)"} />
                </Stat>
                <Stat label="Memory" value={service.mem} unit="MB" wide>
                  <span className="stat-side mono">of {service.memMax} MB</span>
                </Stat>
                <div className="stat wide flush"><Meter value={service.mem} max={service.memMax} color={running ? "var(--lav)" : "var(--line)"} /></div>
              </div>
            </Card>
            <EnvCard service={service} />
            <QuickCard service={service} />
          </aside>
        </div>
      </div>
    </main>
  );
};

const MainStyles = () => (
  <style>{`
.main{flex:1;min-width:0;display:flex;flex-direction:column;background:var(--canvas);min-height:0}
.head{flex:none;padding:16px 24px 14px;display:flex;flex-direction:column;gap:12px;border-bottom:1px solid var(--line-soft)}
.crumbs{display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--faint);letter-spacing:0.01em}
.crumbs svg{opacity:.6}
.head-row{display:flex;align-items:center;gap:14px}
.head-ava{width:46px;height:46px;flex:none;border-radius:14px;display:grid;place-items:center;background:var(--surface);box-shadow:var(--shadow)}
.head-id{min-width:0}
.head-status{display:flex;align-items:center;gap:7px;font-size:11px}
.hs-word{font-size:9.5px;letter-spacing:0.14em;text-transform:uppercase}
.hs-note{color:var(--faint);font-size:11px;white-space:nowrap}
.head-name{margin:2px 0 0;font-size:40px;line-height:1;display:flex;align-items:baseline;gap:12px;color:var(--text)}
.head-kind{font-size:10px;color:var(--dim);background:var(--surface);border-radius:999px;padding:4px 10px;letter-spacing:0.04em;white-space:nowrap}
.head-acts{margin-left:auto;display:flex;align-items:center;gap:4px}
.chips{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.chip{display:inline-flex;align-items:center;gap:8px;height:30px;padding:0 12px;border-radius:999px;background:var(--frame);color:var(--muted);font-size:11.5px;flex:none;max-width:340px;transition:all .14s}
.chip .mono{font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip:hover{background:var(--surface-2);color:var(--text)}
.chip.link svg:first-child{color:var(--ice)}
.chip-act{color:var(--faint);font-family:var(--mono);font-size:10px;display:inline-flex;align-items:center}

.body{position:relative;flex:1;min-height:0;padding:16px 24px 24px;display:flex;flex-direction:column;gap:14px}
.cols{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 306px;gap:14px}
.col-a{display:flex;flex-direction:column;gap:14px;min-height:0}
.col-b{display:flex;flex-direction:column;gap:14px;min-height:0;overflow-y:auto;scrollbar-width:none}
.col-b::-webkit-scrollbar{display:none}

.incident{display:flex;align-items:flex-start;gap:14px;padding:14px 16px;border-radius:16px;background:var(--coral-wash);box-shadow:inset 0 0 0 1px oklch(0.76 0.13 25/0.22)}
.inc-ico{color:var(--coral);flex:none;margin-top:1px}
.inc-text{min-width:0}
.inc-title{font-size:17px;color:var(--text);line-height:1.2}
.inc-detail{margin:3px 0 0;font-size:12px;line-height:1.5;color:var(--muted);max-width:62ch;text-wrap:pretty}
.inc-acts{margin-left:auto;display:flex;gap:6px;flex:none;padding-top:2px}

.cmds{display:flex;flex-direction:column}
.cmd{display:flex;align-items:center;gap:12px;padding:0 14px 0 10px;height:44px;border-top:1px solid var(--line-soft)}
.cmd:first-child{border-top:0}
.cmd:hover{background:var(--surface-2)}
.cmd-run{width:26px;height:26px;flex:none;border-radius:8px;display:grid;place-items:center;color:var(--mint);background:var(--mint-wash);opacity:.75;transition:opacity .14s}
.cmd:hover .cmd-run{opacity:1}
.cmd-name{font-size:12.5px;font-weight:500;width:108px;flex:none;display:flex;align-items:center;gap:8px}
.cmd-badge{color:var(--faint);font-size:8.5px}
.cmd-code{flex:1;min-width:0;font-size:11.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cmd:hover .cmd-code{color:var(--muted)}
.cmd-env{flex:none;white-space:nowrap;font-size:10px;color:var(--ice);background:var(--ice-wash);border-radius:6px;padding:2px 7px}
.cmd-more{color:var(--faint);display:grid;place-items:center;opacity:0}
.cmd:hover .cmd-more{opacity:1}

.stats{display:grid;grid-template-columns:1fr 1fr;gap:14px 10px}
.stat{display:flex;flex-direction:column;gap:4px;min-width:0}
.stat.wide{grid-column:span 2}
.stat.flush{margin-top:-6px}
.stat-row{display:flex;align-items:flex-end;justify-content:space-between;gap:8px}
.stat-val{font-size:26px;line-height:1;color:var(--text);display:inline-flex;align-items:baseline;gap:3px}
.stat-unit{font-size:10.5px;color:var(--dim)}
.stat-side{font-size:10.5px;color:var(--faint)}

.env-tabs{display:flex;gap:6px;margin-bottom:10px}
.env-tab{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:8px;font-size:11px;color:var(--dim);background:var(--sunken);transition:all .14s}
.env-tab:hover{color:var(--text)}
.env-tab.on{color:var(--lav);background:var(--lav-wash)}
.env-vars{display:flex;flex-direction:column;gap:10px}
.env-var{display:flex;flex-direction:column;gap:2px;min-width:0}
.env-krow{display:flex;align-items:center;gap:6px}
.env-k{font-size:9.5px;letter-spacing:0.1em;text-transform:uppercase;color:var(--faint);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.env-v{font-size:11px;color:var(--text);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.env-reveal{color:var(--faint);flex:none;display:grid;place-items:center;margin-left:auto}
.env-reveal:hover{color:var(--text)}

.quick{display:flex;flex-direction:column}
.qrow{display:flex;align-items:center;gap:10px;height:38px;padding:0 16px;font-size:12px;color:var(--muted);border-top:1px solid var(--line-soft);text-align:left}
.qrow:first-child{border-top:0}
.qrow svg{color:var(--dim);flex:none}
.qrow span:first-of-type{flex:1}
.qrow:hover{background:var(--surface-2);color:var(--text)}
.qrow:hover svg{color:var(--text)}
.qrow.danger:hover{color:var(--coral)}
.qrow.danger:hover svg{color:var(--coral)}
.qrow:disabled{opacity:.35;cursor:default}
.qrow:disabled:hover{background:none;color:var(--muted)}

@media (max-width:1180px){.cols{display:flex;flex-direction:column;flex:none;min-height:0}.col-a{flex:none}.term{min-height:360px}.col-b{flex-direction:row;overflow:visible;flex:none}.col-b>*{flex:1}}
  `}</style>
);

Object.assign(window, { MainPanel, MainStyles, Incident, EnvCard, CommandsCard, QuickCard, Stat });
