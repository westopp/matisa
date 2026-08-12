/* Matisa 2 — fleet board */

const Tile = ({ s, selected, onOpen, onToggle }) => {
  const running = s.status === "running";
  const errored = s.status === "errored";
  return (
    <div className={`tile st-${s.status} ${selected ? "on" : ""}`} onClick={() => onOpen(s.id)} role="button" tabIndex={0}>
      <div className="tile-mid">
        <span className="tile-ico">{React.createElement(kindIcon(s), { size: 15 })}</span>
        <span className="tile-name serif">{s.name}</span>
        <button className="tile-more" title="More" onClick={(e) => { e.stopPropagation(); onOpen(s.id); }}><Icons.More size={18} sw={3} /></button>
        <button className="tile-run" title={running ? `Stop ${s.name}` : `Start ${s.name}`} onClick={(e) => { e.stopPropagation(); onToggle(s.id); }}>
          {running ? <Icons.Stop size={14} /> : <Icons.Play size={16} />}
        </button>
      </div>
      <div className="tile-chips">
        <Dot status={s.status} size={6} pulse />
        <span className="pill mono">{s.port ? `:${s.port}` : s.kind}</span>
        <span className="pill mono">{running ? `${s.cpu.toFixed(1)}% • ${s.mem}MB` : errored ? "exit 1" : "idle"}</span>
        <span className="pill mono">{s.env}</span>
      </div>
    </div>
  );
};

const Board = ({ services, selectedId, query, filter, onOpen, onToggle, compact }) => {
  const [closed, setClosed] = React.useState({});
  const [shutSec, setShutSec] = React.useState({});
  const byId = Object.fromEntries(services.map(s => [s.id, s]));
  const keep = (s) => {
    if (!s) return false;
    if (filter === "running" && s.status !== "running") return false;
    if (filter === "issues" && s.status !== "errored") return false;
    if (query && !(`${s.name} ${s.group} ${s.port || ""} ${s.kind}`).toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  };
  const bands = TREE.map(sec => ({
    section: sec.section,
    groups: sec.groups.map(g => ({ title: g.title, items: g.ids.map(id => byId[id]).filter(keep) })).filter(g => g.items.length),
  })).filter(b => b.groups.length);

  return (
    <div className={`board scroll ${compact ? "compact" : ""}`}>
      {bands.map(b => (
        <section className={`band ${shutSec[b.section] ? "shut" : ""}`} key={b.section}>
          <button className="band-head" onClick={() => setShutSec(s => ({ ...s, [b.section]: !s[b.section] }))}>
            <h2 className="band-title serif">{b.section}</h2>
            <span className={`band-caret ${shutSec[b.section] ? "shut" : ""}`}><Icons.ChevronDown size={14} /></span>
            <span className="band-n mono">{b.groups.reduce((n, g) => n + g.items.length, 0)}</span>
            {shutSec[b.section] && b.groups.some(g => g.items.some(s => s.status === "errored")) && <span className="grp-issue mono">issues</span>}
          </button>
          {!shutSec[b.section] && <div className="band-groups">
            {b.groups.map(g => {
              const key = b.section + g.title, shut = closed[key];
              const issues = g.items.filter(s => s.status === "errored").length;
              return (
                <div className={`grp ${shut ? "shut" : ""}`} key={key}>
                  <button className="grp-head" onClick={() => setClosed(c => ({ ...c, [key]: !c[key] }))}>
                    <span className="grp-title">{g.title}</span>
                    <span className={`grp-caret ${shut ? "shut" : ""}`}><Icons.ChevronDown size={13} /></span>
                    <span className="grp-n mono">{g.items.length}</span>
                    {shut && issues > 0 && <span className="grp-issue mono">{issues} issue{issues > 1 ? "s" : ""}</span>}
                  </button>
                  {!shut && (
                    <div className="grid">
                      {g.items.map(s => <Tile key={s.id} s={s} selected={s.id === selectedId} onOpen={onOpen} onToggle={onToggle} />)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>}
        </section>
      ))}
      {!bands.length && (
        <div className="board-empty">
          <p className="serif">Nothing matches</p>
          <span className="mono">try another filter</span>
        </div>
      )}
    </div>
  );
};

const BoardStyles = () => (
  <style>{`
.board{flex:1;min-height:0;padding:24px 30px 34px;display:flex;flex-direction:column;gap:22px}
.band.shut{gap:0}
.band{display:flex;flex-direction:column;gap:8px}
.band-head{display:flex;align-items:center;gap:9px;align-self:flex-start;color:var(--text);padding:2px 6px 2px 0;border-radius:9px}
.band-head:hover .band-caret{color:var(--text)}
.band-title{font-size:19px;line-height:1.1;margin:0;color:var(--text);letter-spacing:-0.03em}
.band-caret{display:grid;place-items:center;color:var(--dim);transition:transform .18s,color .14s}
.band-caret.shut{transform:rotate(-90deg)}
.band-n{font-size:10.5px;color:var(--dim)}
.band-groups{display:flex;flex-direction:column;gap:6px;margin-left:2px;padding-left:20px;border-left:1px solid var(--line)}
.grp{display:flex;flex-direction:column;gap:10px;padding:4px 0 10px}
.grp.shut{padding-bottom:0}
.grp-head{display:flex;align-items:center;gap:8px;align-self:flex-start;height:30px;padding:0 10px 0 2px;border-radius:9px;color:var(--dim);transition:color .14s}
.grp-head:hover{color:var(--text)}
.grp-title{font-size:14px;font-weight:600;letter-spacing:-0.02em;white-space:nowrap}
.grp-caret{display:grid;place-items:center;transition:transform .18s}
.grp-caret.shut{transform:rotate(-90deg)}
.grp-n{font-size:10px;opacity:.7}
.grp-issue{font-size:10px;color:var(--coral)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(268px,320px));justify-content:start;gap:12px}

.tile{position:relative;border-radius:20px;padding:14px 15px;display:flex;flex-direction:column;gap:10px;cursor:pointer;background:var(--raise);color:var(--text);transition:transform .16s cubic-bezier(.3,.8,.3,1),box-shadow .16s,background .16s,padding .3s ease,border-radius .3s ease}
.tile:hover{transform:translateY(-2px)}
.tile-top{display:none}
.tile-ico{width:30px;height:30px;border-radius:10px;display:grid;place-items:center;background:oklch(1 0 0/.07);color:var(--muted)}
.tile-more{margin-left:auto}
.tile-more+.tile-run{margin-left:0}
.tile-mid{display:flex;align-items:center;gap:11px}
.tile-ico{flex:none}
.tile-more{flex:none;width:24px;height:22px;border-radius:8px;display:grid;place-items:center;color:var(--dim);transition:color .14s}
.tile-more:hover{color:var(--text)}
.tile-name{flex:1;min-width:0;font-size:22px;line-height:1.1;letter-spacing:-0.035em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile-run{width:24px;height:24px;flex:none;display:grid;place-items:center;color:var(--run);transition:transform .14s,filter .14s}
.tile-run:hover{transform:scale(1.14)}
.tile-msg{margin:-2px 0 0;font-size:12px;font-weight:500;line-height:1.35;opacity:.9;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
.tile-chips{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding-left:2px}
.pill{font-size:10.5px;padding:4px 9px;border-radius:999px;background:oklch(1 0 0/.07);color:var(--dim);white-space:nowrap}

.tile.on.st-running{background:var(--lav);color:var(--ink)}
.tile.on.st-running .tile-ico{background:oklch(1 0 0/.32);color:var(--ink)}
.tile.on.st-running .pill{background:oklch(1 0 0/.32);color:oklch(0.3 0.05 300/.85)}
.tile.on.st-running:hover{filter:brightness(1.04)}
.tile.on.st-errored{background:var(--coral);color:var(--ink)}
.tile.on.st-errored .tile-ico{background:oklch(1 0 0/.3);color:var(--ink)}
.tile.on.st-errored .pill{background:oklch(1 0 0/.3);color:oklch(0.3 0.07 25/.85)}
.tile.on.st-errored .tile-more,.tile.on.st-running .tile-more{color:oklch(0.32 0.06 25/.6)}
.tile.on.st-running .tile-more{color:oklch(0.32 0.05 300/.6)}
.tile.on.st-errored .tile-more:hover,.tile.on.st-running .tile-more:hover{color:var(--ink)}
.tile.on.st-running .dot{background:oklch(0.42 0.12 300)}
.tile.on.st-errored .dot{background:oklch(0.5 0.19 25)}
.tile.on.st-running .dot.pulse{animation:none;box-shadow:0 0 0 3px oklch(0.42 0.12 300/.22)}
.tile{--run:oklch(0.72 0.17 150)}
.tile.on.st-running,.tile.on.st-errored{--run:oklch(0.48 0.18 150)}
.tile.st-stopped .tile-name{color:var(--muted)}
.tile:hover{background:var(--raise-2)}
.tile.on.st-stopped{background:var(--raise-2);box-shadow:0 0 0 2px var(--ice)}
.tile.on.st-stopped .tile-name{color:var(--text)}

.board-tail{display:flex;gap:12px}
.ghost-tile{display:inline-flex;align-items:center;gap:9px;height:46px;padding:0 20px;border-radius:16px;color:var(--dim);font-size:13px;font-weight:600;box-shadow:inset 0 0 0 1px var(--line);transition:all .15s}
.ghost-tile:hover{color:var(--text);box-shadow:inset 0 0 0 1px var(--line-hi)}
.board-empty{padding:70px 0;text-align:center;display:flex;flex-direction:column;gap:6px}
.board-empty .serif{font-size:24px;margin:0;color:var(--muted)}
.board-empty .mono{font-size:11px;color:var(--dim)}

.board.compact{padding:4px 14px 22px;gap:14px}
.compact .band{gap:6px}
.compact .band-head{padding:2px 6px 2px 8px}
.compact .band-title{font-size:15px;letter-spacing:-0.02em}
.compact .band-n{font-size:9.5px}
.compact .band-groups{margin-left:10px;padding-left:12px;gap:2px}
.compact .grp{gap:7px;padding:2px 0 8px}
.compact .grp-head{height:26px}
.compact .grp-title{font-size:12.5px}
.compact .grid{grid-template-columns:minmax(0,1fr);gap:7px}
.compact .tile{border-radius:14px;padding:10px 11px;gap:7px}
.compact .tile:hover{transform:none}
.compact .tile-ico{width:25px;height:25px;border-radius:8px}
.compact .tile-ico svg{width:13px;height:13px}
.compact .tile-mid{gap:9px}
.compact .tile-name{font-size:16px;letter-spacing:-0.03em}
.compact .tile-more{width:20px;height:18px}
.compact .tile-more svg{width:15px;height:15px}
.compact .tile-run{width:20px;height:20px}
.compact .tile-run svg{width:13px;height:13px}
.compact .pill{font-size:9.5px;padding:3px 7px}
.compact .tile.on.st-stopped{box-shadow:0 0 0 2px var(--ice)}
.compact .board-empty{padding:40px 0}
.compact .board-empty .serif{font-size:18px}
  `}</style>
);

Object.assign(window, { Board, Tile, BoardStyles });
