'use strict';
// The dashboard page: one file, inlined, no build step and no CDN — keel has never had a
// package.json and this is not the feature that should give it one.
//
// The embedded script deliberately uses string concatenation rather than template literals, so
// that this outer template literal needs no escaping and stays readable.

function html() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>keel</title>
<style>
:root{
  --bg:#f7f6f3; --panel:#ffffff; --border:#e3e0d9; --fg:#1c1b19; --dim:#6f6b63;
  --faint:#9b968c; --accent:#7a5cff; --ok:#1f8a4c; --warn:#b26a00; --bad:#c0392b;
  --run:#0b74c4; --rail:#d9d5cc; --shadow:0 1px 2px rgba(0,0,0,.05);
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --bg:#131314; --panel:#1a1a1c; --border:#2c2c30; --fg:#e9e7e3; --dim:#9a958c;
    --faint:#6b675f; --accent:#a48bff; --ok:#4ec07c; --warn:#e0a13a; --bad:#f0685a;
    --run:#57aeff; --rail:#333338; --shadow:none;
  }
}
:root[data-theme="dark"]{
  --bg:#131314; --panel:#1a1a1c; --border:#2c2c30; --fg:#e9e7e3; --dim:#9a958c;
  --faint:#6b675f; --accent:#a48bff; --ok:#4ec07c; --warn:#e0a13a; --bad:#f0685a;
  --run:#57aeff; --rail:#333338; --shadow:none;
}
*{box-sizing:border-box}
body{
  margin:0; background:var(--bg); color:var(--fg);
  font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  padding-block:0; padding-inline:16px;
}
.wrap{max-width:1180px;margin:0 auto;padding-block:18px 56px}

header.bar{
  display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 18px;
  padding:14px 16px;margin-bottom:16px;
  background:var(--panel);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow);
}
.brand{font-weight:700;letter-spacing:.14em;text-transform:uppercase;font-size:12px}
.brand .mark{color:var(--accent)}
h1{font-size:14px;margin:0;font-weight:600}
.meta{color:var(--dim);display:flex;flex-wrap:wrap;gap:14px;margin-left:auto;font-size:12px}
.meta b{font-weight:600;color:var(--fg)}
.live{display:inline-flex;align-items:center;gap:6px;color:var(--ok)}
.live .dot{width:7px;height:7px;border-radius:50%;background:var(--ok);animation:p 2s ease-in-out infinite}
.live.off{color:var(--faint)} .live.off .dot{background:var(--faint);animation:none}
@keyframes p{0%,100%{opacity:1}50%{opacity:.25}}

.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
@media (max-width:820px){.grid{grid-template-columns:1fr}}

section.card{
  background:var(--panel);border:1px solid var(--border);border-radius:10px;
  padding:14px 16px;margin-bottom:14px;box-shadow:var(--shadow);min-width:0;
}
.grid section.card{margin-bottom:0}
.card > h2{
  font-size:10.5px;letter-spacing:.15em;text-transform:uppercase;color:var(--faint);
  margin:0 0 12px;font-weight:700;display:flex;justify-content:space-between;gap:12px;align-items:baseline;
}
.card > h2 .tag{letter-spacing:0;text-transform:none;color:var(--dim);font-weight:500;font-size:11.5px}

.note{color:var(--dim);font-size:11.5px;line-height:1.5;margin-top:12px;
  padding-left:11px;border-left:2px solid var(--border)}

/* flow rail */
.rail{display:flex;flex-wrap:wrap;gap:3px 0;align-items:stretch}
.rs{display:flex;align-items:center;gap:6px;padding:5px 9px;border-radius:6px;
  color:var(--faint);white-space:nowrap;font-size:12px}
.rs + .rs{margin-left:1px}
.rs .g{font-size:10px;opacity:.85}
.rs.done{color:var(--ok)}
.rs.current{color:var(--fg);background:var(--rail);font-weight:700;box-shadow:inset 0 0 0 1px var(--border)}
.rs.pending{color:var(--faint)}

/* progress — never name this .bar: header.bar would match it and be clipped to 6px */
.progress{height:6px;border-radius:99px;background:var(--rail);overflow:hidden;margin:12px 0 6px}
.progress > i{display:block;height:100%;background:var(--ok);border-radius:99px;transition:width .4s ease}

/* AC list */
.acs{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:2px 16px}
.ac{display:flex;gap:9px;align-items:baseline;padding:3px 0;min-width:0}
.ac .id{font-weight:600}
.ac .st{color:var(--dim);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ac .ly{margin-left:auto;color:var(--faint);font-size:11px;flex:none}
.ac.cur{color:var(--run)} .ac.cur .st{color:var(--run)}
.ac.done .g{color:var(--ok)}

/* three-step loop */
.steps{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.step{flex:1 1 110px;border:1px solid var(--border);border-radius:8px;padding:9px 11px}
.step .n{font-weight:700;font-size:12px}
.step .s{color:var(--faint);font-size:11.5px;margin-top:2px}
.step.running{border-color:var(--run)} .step.running .n{color:var(--run)}
.step.running .s{color:var(--run)}
.step.done .n{color:var(--ok)}

/* rows */
.row{display:flex;gap:10px;align-items:baseline;padding:3px 0;min-width:0}
.row .k{width:88px;flex:none;color:var(--dim)}
.row .v{min-width:0;overflow-wrap:anywhere}
.row .t{margin-left:auto;color:var(--faint);font-size:11.5px;flex:none}

/* timeline */
.feed{display:flex;flex-direction:column;gap:1px;max-height:340px;overflow:auto;
  margin:0 -6px;padding:0 6px}
.ev{display:flex;gap:10px;align-items:baseline;padding:3px 0;border-radius:4px;min-width:0}
.ev .ts{color:var(--faint);flex:none;font-size:11.5px;font-variant-numeric:tabular-nums}
.ev .kd{flex:none;width:52px;color:var(--dim);font-size:11.5px}
.ev .bd{min-width:3.5em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}
/* Shrinkable, or a long verdict like "GREEN-RESULT: stalled" pushes the row past the card on a
   narrow screen while the body text collapses to nothing. */
.ev .rt{margin-left:auto;flex:0 1 auto;min-width:0;max-width:50%;font-size:11.5px;color:var(--faint);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (max-width:560px){ .ev .kd{display:none} .ev .rt{max-width:40%} }
.ev.bad .bd{color:var(--bad)} .ev.bad .rt{color:var(--bad)}
.ev.guard .bd{color:var(--warn)}
.ev .sub{color:var(--bad);font-size:11.5px}
.filters{display:flex;flex-wrap:wrap;gap:5px;margin-top:12px}
.filters button{
  font:inherit;font-size:11.5px;padding:3px 10px;border-radius:99px;cursor:pointer;
  background:transparent;color:var(--dim);border:1px solid var(--border);
}
.filters button:hover{color:var(--fg)}
.filters button[aria-pressed="true"]{background:var(--fg);color:var(--bg);border-color:var(--fg)}

/* status glyphs */
.g{flex:none;width:12px;display:inline-block;text-align:center}
.ok{color:var(--ok)} .bad{color:var(--bad)} .warn{color:var(--warn)}
.run{color:var(--run)} .faint{color:var(--faint)} .dim{color:var(--dim)}

/* questions + blockers */
.q{border-left:3px solid var(--warn);padding:2px 0 2px 12px;margin-bottom:12px}
.q:last-child{margin-bottom:0}
.q .qq{font-weight:600}
.q .qb{color:var(--dim);font-size:11.5px;margin-top:2px}
.q .qm{color:var(--faint);font-size:11.5px;margin-top:3px}
.bl{border-left:3px solid var(--bad);padding:2px 0 2px 12px;margin-bottom:10px}
.bl:last-child{margin-bottom:0}
.bl .bn{font-weight:600;color:var(--bad)}
.bl .bw{color:var(--dim)}
.bl .bf{margin-top:3px}
code{background:var(--rail);padding:1px 6px;border-radius:4px;font:inherit;overflow-wrap:anywhere}

/* frozen */
.buckets{display:flex;flex-wrap:wrap;gap:5px;margin-top:4px}
.bk{font-size:11.5px;padding:2px 9px;border-radius:99px;border:1px solid var(--border);color:var(--dim)}
.bk.a{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 35%,transparent)}
.bk.d{color:var(--faint);text-decoration:line-through;text-decoration-thickness:1px}
.bk.c{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 35%,transparent)}

/* next */
.next{border-color:var(--accent)}
.next .do{font-size:14px;font-weight:600;margin-bottom:10px}
.next code{background:var(--fg);color:var(--bg);padding:6px 12px;display:inline-block;border-radius:6px}

.empty{color:var(--faint)}
.center{text-align:center;padding:52px 16px}
.center .big{font-size:15px;font-weight:600;margin-bottom:8px}
.flowlist{display:inline-flex;flex-direction:column;gap:7px;text-align:left;margin-top:20px}
.flowlist .fl{display:flex;gap:14px}
.flowlist .fl code{flex:none}
.flowlist .fl span{color:var(--dim)}
</style>
</head>
<body>
<div class="wrap" id="app"><div class="center"><div class="big">connecting…</div></div></div>
<script>
(function(){
  'use strict';
  var app = document.getElementById('app');
  var filter = 'all';
  var connected = false;
  var last = null;

  function esc(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function clock(iso){
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var p = function(n){ return (n<10?'0':'') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function dur(sec){
    if (sec == null) return '';
    if (sec < 60) return sec + 's';
    var m = Math.floor(sec/60), s = sec % 60;
    if (m < 60) return m + 'm ' + s + 's';
    return Math.floor(m/60) + 'h ' + (m%60) + 'm';
  }
  function ms(n){
    if (n == null) return '';
    return n < 1000 ? n + 'ms' : (n/1000).toFixed(1) + 's';
  }
  function card(title, tag, body, cls){
    return '<section class="card ' + (cls||'') + '"><h2>' + esc(title) +
      (tag ? '<span class="tag">' + esc(tag) + '</span>' : '') + '</h2>' + body + '</section>';
  }
  function note(text){ return '<div class="note">' + esc(text) + '</div>'; }

  var GLYPH = { done:'\\u2714', current:'\\u25b6', pending:'\\u00b7',
    pass:'\\u2714', fail:'\\u2717', stale:'\\u00b7', none:'\\u00b7', skipped:'\\u2014' };

  function renderFlow(v){
    var f = v.flow; if (!f) return '';
    var rail = f.steps.map(function(s){
      return '<span class="rs ' + s.state + '"><i class="g">' + GLYPH[s.state] + '</i>' + esc(s.label) + '</span>';
    }).join('');
    var tag = f.onRail ? ('phase ' + (f.index+1) + ' of ' + f.total)
                       : (esc(f.phase) + ' \\u2014 off the rail');
    var body = '<div class="rail">' + rail + '</div>';
    if (f.phaseBlurb) body += note(f.phaseBlurb);
    return card('flow \\u00b7 ' + f.flow, tag, body);
  }

  function renderQuestions(v){
    if (!v.questions || !v.questions.length) return '';
    var body = v.questions.map(function(q){
      return '<div class="q"><div class="qq">' + (q.blocking ? '\\u25b8 ' : '') + esc(q.question) + '</div>' +
        (q.because ? '<div class="qb">because ' + esc(q.because) + '</div>' : '') +
        '<div class="qm">' + esc(q.id) + (q.raisedBy ? ' \\u00b7 raised by ' + esc(q.raisedBy) : '') +
        (q.ageSeconds != null ? ' \\u00b7 ' + dur(q.ageSeconds) + ' ago' : '') +
        ' \\u00b7 answer with <code>keel ask ' + esc(q.id) + ' --answer "\\u2026" --by user</code></div></div>';
    }).join('');
    return card('waiting on you', v.questions.length + ' open', body +
      note('Blocking questions stop the flow until answered. keel records them in .keel/questions.json.'));
  }

  function renderAcs(v){
    var a = v.acs; if (!a || !a.total) return '';
    var items = a.items.map(function(x){
      var cls = x.current ? 'cur' : (x.status === 'done' || x.status === 'already-met') ? 'done' : '';
      var g = x.current ? GLYPH.current : (x.status === 'done' || x.status === 'already-met') ? GLYPH.done : GLYPH.pending;
      var st = x.status === 'done' ? 'done \\u00b7 red+green'
        : x.status === 'already-met' ? 'already met'
        : x.current ? (v.flow ? v.flow.phase : 'current')
        : x.status === 'green' ? 'green' : x.status === 'red' ? 'red' : 'not started';
      return '<div class="ac ' + cls + '"><i class="g">' + g + '</i>' +
        '<span class="id">' + esc(x.id) + '</span><span class="st">' + esc(st) + '</span>' +
        '<span class="ly">' + esc(x.layer ? '[' + x.layer + ']' : '') + '</span></div>';
    }).join('');
    var body = '<div class="acs">' + items + '</div>' +
      '<div class="progress"><i style="width:' + a.percent + '%"></i></div>' +
      '<div class="row"><span class="v dim">' + a.done + ' of ' + a.total + ' done' +
      (v.gateDue ? ' \\u00b7 ' + esc(v.gateDue.due ? 'gate due for ' + a.current : 'no gate for ' + a.current) : '') +
      '</span><span class="t">' + a.percent + '%</span></div>';
    return card('acceptance criteria', null, body);
  }

  function renderCurrent(v){
    var c = v.current; if (!c) return '';
    var steps = c.steps.map(function(s){
      var label = s.state === 'running' ? 'running' : s.state === 'done' ? 'done' : 'waiting';
      return '<div class="step ' + s.state + '"><div class="n">' + esc(s.step) + '</div>' +
        '<div class="s">' + label + '</div></div>';
    }).join('');
    var body = '<div class="steps">' + steps + '</div>' +
      (c.red ? '<div class="row"><span class="k">red</span><span class="v">' + esc(c.red) + '</span></div>' : '') +
      (c.green ? '<div class="row"><span class="k">green</span><span class="v">' + esc(c.green) + '</span></div>' : '');
    return card('current \\u00b7 ' + c.id, c.layer ? '[' + c.layer + ']' : null, body);
  }

  function renderHunt(v){
    var h = v.hunt; if (!h) return '';
    var counts = Object.keys(h.counts || {}).map(function(k){
      return '<span class="bk">' + esc(k) + ' ' + esc(h.counts[k]) + '</span>';
    }).join('');
    var body = '<div class="buckets">' + counts + '</div>' +
      '<div class="row" style="margin-top:10px"><span class="k">lenses</span><span class="v">' +
        esc((h.lenses.confirmed || []).join(' \\u00b7 ') || 'none confirmed yet') + '</span></div>' +
      '<div class="row"><span class="k">swept</span><span class="v">' + esc(h.lenses.swept) +
        ' of ' + esc((h.lenses.confirmed || []).length) + ' lenses' +
        (h.lenses.sweeps ? ' \\u00b7 ' + esc(h.lenses.sweeps) + ' sweeps across lanes' : '') +
        '</span></div>';
    var findings = (h.findings || []).map(function(f){
      return '<div class="row"><span class="k">' + esc(f.id) + '</span><span class="v">' + esc(f.title) +
        '</span><span class="t">' + esc(f.severity || f.status) + '</span></div>';
    }).join('');
    return card('findings', h.open + ' open \\u00b7 rev ' + h.rev,
      body + (findings ? '<div style="margin-top:10px">' + findings + '</div>' : '') +
      note('The hunt is read-only end to end. Fixes leave through a fix or feature flow.'));
  }

  function renderAgents(v){
    var a = v.agents; if (!a) return '';
    var running = (a.running || []).length
      ? a.running.map(function(r){
          return '<div class="row"><i class="g run">\\u25cf</i><span class="v">' + esc(r.agent) +
            (r.count > 1 ? ' \\u00d7' + r.count : '') + '</span><span class="t">' +
            (r.count > 1 ? 'oldest ' : '') + dur(r.oldestSeconds) +
            (r.stale ? ' \\u00b7 stale?' : '') + '</span></div>';
        }).join('')
      : '<div class="empty">none running</div>';
    var verdicts = (a.verdicts || []).map(function(x){
      return '<div class="row"><i class="g ' + (x.ok ? 'ok' : 'bad') + '">' +
        (x.ok ? GLYPH.pass : GLYPH.fail) + '</i><span class="v">' + esc(x.agent) +
        '</span><span class="t">' + esc(x.verdict) + ' \\u00b7 ' + clock(x.at) + '</span></div>';
    }).join('');
    var body = running + (verdicts
      ? '<div class="row" style="margin-top:10px"><span class="v faint">last verdicts</span></div>' + verdicts
      : '');
    return card('agents', null, body +
      note('Starts and stops, not per-instance timers \\u2014 the hook payload carries no instance id.'));
  }

  function renderFeed(v){
    var evs = v.timeline || [];
    var rows = evs.length ? evs.map(function(e){
      var cls = e.ok === false ? 'bad' : e.kind === 'guard' ? 'guard' : '';
      var body = '', right = '';
      if (e.kind === 'tool'){ body = esc(e.tool) + '  ' + esc(e.arg || ''); right = (e.ok === false ? 'FAIL' : 'ok') + (e.ms != null ? '  ' + ms(e.ms) : ''); }
      else if (e.kind === 'agent'){ body = esc(e.agent) + ' ' + esc(e.ev); right = esc(e.verdict || e.ac || ''); }
      else if (e.kind === 'phase'){ body = esc(e.from) + ' \\u2192 ' + esc(e.to); }
      else if (e.kind === 'gate'){ body = esc(e.ac || e.gate || '') + '  ' + esc(e.verdict || ''); }
      else if (e.kind === 'guard'){ body = esc(e.tool) + ' denied  ' + esc(e.arg || ''); right = esc(e.denied || ''); }
      return '<div class="ev ' + cls + '"><span class="ts">' + clock(e.at) + '</span>' +
        '<span class="kd">' + esc(e.kind) + '</span>' +
        '<span class="bd">' + body + '</span>' +
        '<span class="rt">' + right + '</span></div>' +
        (e.detail ? '<div class="ev"><span class="ts"></span><span class="kd"></span><span class="bd sub">' + esc(e.detail) + '</span></div>' : '');
    }).join('') : '<div class="empty">no events recorded yet</div>';

    var names = ['all','tools','agents','phases','gates','guards','failures'];
    var btns = names.map(function(n){
      return '<button data-f="' + n + '" aria-pressed="' + (n === filter) + '">' + n + '</button>';
    }).join('');
    return card('tool feed', (v.timelineTotal || 0) + ' events',
      '<div class="feed">' + rows + '</div><div class="filters">' + btns + '</div>');
  }

  function renderChecks(v){
    var rows = (v.checks || []).map(function(c){
      var g = GLYPH[c.state] || '\\u00b7';
      var cl = c.state === 'pass' ? 'ok' : c.state === 'fail' ? 'bad' : 'faint';
      return '<div class="row"><i class="g ' + cl + '">' + g + '</i><span class="k">' + esc(c.name) +
        '</span><span class="v dim">' + esc(c.label) + '</span></div>';
    }).join('');
    var extra = [];
    if (v.stall) extra.push('stall ' + v.stall.count + (v.stall.step ? ' \\u00b7 ladder ' + v.stall.step + '/4' : ''));
    if (v.flaky) extra.push('flaky ' + v.flaky);
    if (v.unlocks) extra.push('unlocks ' + v.unlocks);
    var sk = Object.keys(v.gatesSkipped || {});
    extra.push('gates skipped: ' + (sk.length ? sk.join(', ') : 'none'));
    return card('checks', null, rows +
      '<div class="row" style="margin-top:8px"><span class="v faint">' + esc(extra.join('   ')) + '</span></div>');
  }

  function renderBlockers(v){
    var b = v.blockers || [];
    var body = b.length ? b.map(function(x){
      return '<div class="bl"><div class="bn">' + esc(x.gate) + '</div>' +
        '<div class="bw">' + esc(x.why) + '</div>' +
        '<div class="bf">\\u2192 <code>' + esc(x.fix) + '</code></div></div>';
    }).join('') : '<div class="row"><i class="g ok">' + GLYPH.pass + '</i><span class="v">nothing is blocking a push</span></div>';
    return card('blocking a push', b.length ? b.length + ' gate' + (b.length>1?'s':'') : null, body +
      note('The same predicate the pre-tool hook blocks git push on \\u2014 this cannot disagree with it.'));
  }

  function renderFrozen(v){
    var f = v.frozen; if (!f) return '';
    var chip = function(b, cls){ return '<span class="bk ' + cls + '">' + esc(b) + '</span>'; };
    var body = '<div class="row"><span class="k ok">allowed</span><span class="v"><span class="buckets">' +
        (f.allowed.map(function(b){ return chip(b,'a'); }).join('') || '<span class="empty">nothing</span>') + '</span></span></div>' +
      '<div class="row" style="margin-top:8px"><span class="k faint">denied</span><span class="v"><span class="buckets">' +
        (f.denied.map(function(b){ return chip(b,'d'); }).join('') || '<span class="empty">nothing</span>') + '</span></span></div>' +
      (f.conditional.length ? '<div class="row" style="margin-top:8px"><span class="k warn">partial</span><span class="v"><span class="buckets">' +
        f.conditional.map(function(c){ return chip(c.bucket + ' \\u00b7 ' + c.rule, 'c'); }).join('') + '</span></span></div>' : '');
    return card("what's frozen \\u00b7 " + f.phase, null, body +
      note('From the guard matrix the pre-tool hook enforces. Open a path deliberately with keel unlock.'));
  }

  function renderNext(v){
    if (!v.next) return '';
    return card('next', null,
      '<div class="do">' + esc(v.next) + '</div>' +
      (v.lastFailure ? '<div class="row"><span class="k">last</span><span class="v bad">' + esc(v.lastFailure) + '</span></div>' : ''),
      'next');
  }

  function renderIdle(v){
    var i = v.idle || {};
    var flows = (i.flows || []).map(function(f){
      return '<div class="fl"><code>/keel:' + esc(f.flow) + '</code><span>' + esc(f.blurb) + '</span></div>';
    }).join('');
    var lf = i.lastFlow
      ? '<div class="row" style="justify-content:center;margin-top:24px"><span class="v faint">last flow \\u00b7 ' +
        esc(i.lastFlow.spec || i.lastFlow.flow) + ' \\u00b7 ' + i.lastFlow.done + '/' + i.lastFlow.total + ' ACs</span></div>'
      : '';
    return '<div class="center"><div class="big">Nothing running.</div>' +
      '<div class="dim">' + (v.configured ? 'config .keel/config.yml \\u2714' : 'not configured \\u2014 run keel init --write') + '</div>' +
      '<div class="flowlist">' + flows + '</div>' + lf + '</div>';
  }

  function header(v){
    var h = v.header;
    var live = '<span class="live' + (connected ? '' : ' off') + '"><i class="dot"></i>' +
      (connected ? 'live' : 'offline') + '</span>';
    var meta = h
      ? '<span>lane <b>' + esc(h.lane) + '</b></span>' +
        (h.size ? '<span>flow <b>' + esc(h.size) + '</b></span>' : '') +
        (h.gates ? '<span>gates <b>' + esc(h.gates) + '</b></span>' : '') +
        (v.head ? '<span>head <b>' + esc(v.head) + '</b></span>' : '')
      : '';
    return '<header class="bar"><span class="brand"><span class="mark">\\u25b2</span> keel</span>' +
      '<h1>' + esc(h ? h.title : 'no active flow') + '</h1>' +
      '<div class="meta">' + meta + live + '</div></header>';
  }

  function render(v){
    last = v;
    if (v.error){
      app.innerHTML = header(v) + card('error', null, '<div class="bad">' + esc(v.error) + '</div>');
      return;
    }
    if (!v.active){
      app.innerHTML = header(v) + renderQuestions(v) + renderIdle(v);
      bind();
      return;
    }
    app.innerHTML = header(v) +
      renderQuestions(v) +
      renderFlow(v) +
      '<div class="grid">' + (renderAcs(v) || renderHunt(v) || '') + (renderCurrent(v) || renderAgents(v)) + '</div>' +
      (v.acs && v.acs.total && v.current ? '<div class="grid">' + renderAgents(v) + renderFrozen(v) + '</div>'
                                         : '<div class="grid">' + renderFrozen(v) + renderChecks(v) + '</div>') +
      renderFeed(v) +
      (v.acs && v.acs.total && v.current ? '<div class="grid">' + renderChecks(v) + renderBlockers(v) + '</div>'
                                         : renderBlockers(v)) +
      renderNext(v);
    bind();
  }

  function bind(){
    var btns = app.querySelectorAll('.filters button');
    for (var i = 0; i < btns.length; i++){
      btns[i].addEventListener('click', function(e){
        filter = e.currentTarget.getAttribute('data-f');
        refetch();
      });
    }
  }

  function applyFilter(v){
    if (filter === 'all') return v;
    var f = {
      tools: function(e){ return e.kind === 'tool'; },
      agents: function(e){ return e.kind === 'agent'; },
      phases: function(e){ return e.kind === 'phase'; },
      gates: function(e){ return e.kind === 'gate'; },
      guards: function(e){ return e.kind === 'guard'; },
      failures: function(e){ return e.ok === false || e.kind === 'guard'; }
    }[filter];
    if (!f) return v;
    var copy = {};
    for (var k in v) copy[k] = v[k];
    copy.timeline = (v.timeline || []).filter(f);
    return copy;
  }

  function refetch(){ if (last) render(applyFilter(last)); }

  var es = new EventSource('/events');
  es.onopen = function(){ connected = true; };
  es.onerror = function(){ connected = false; if (last) render(applyFilter(last)); };
  es.onmessage = function(m){
    connected = true;
    var v;
    try { v = JSON.parse(m.data); } catch (e) { return; }
    render(applyFilter(v));
  };
})();
</script>
</body>
</html>`;
}

module.exports = { html };
