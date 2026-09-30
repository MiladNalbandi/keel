'use strict';
// The map tab's CSS and script, as two strings mcp/ui.js interpolates into the one page it serves.
//
// Two files, still no build step and still no CDN. The seam is a string join, not a module
// boundary: SCRIPT is spliced inside the page's IIFE, so it uses that scope's esc, card, note,
// renderGraph and app directly.
//
// The rule from mcp/ui.js:4-6 applies here too and is easy to forget in a second file: the text
// below is JavaScript held in a template literal, so it must use string concatenation, never a
// backtick and never a dollar-brace. A scenario greps the assembled page for both.

const CSS = `
/* map */
.mviews{display:flex;gap:2px;flex-wrap:wrap;margin:-6px 0 14px}
.mviews a{font-size:12px;color:var(--faint);padding:6px 13px;border-radius:7px;text-decoration:none;
  border:1px solid transparent}
.mviews a[aria-current="page"]{background:var(--panel);border-color:var(--border);color:var(--fg);
  font-weight:700;box-shadow:inset 0 2px 0 var(--accent)}
.mviews a:hover{color:var(--fg)}

.mbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;margin-bottom:12px}
.mlevels{display:flex;gap:4px;flex-wrap:wrap}
.mlevels a{font-size:11.5px;background:var(--panel);border:1px solid var(--border);border-radius:7px;
  color:var(--dim);padding:5px 11px;text-decoration:none;white-space:nowrap}
.mlevels a[aria-current="page"]{background:var(--accent);border-color:var(--accent);
  color:var(--on-accent);font-weight:700}
.mcrumb{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px}
.mcrumb a{color:var(--run)}
.mcrumb .sep{color:var(--faint)}
.mcrumb .here{font-weight:700}
.mtip{color:var(--faint);font-size:11.5px;margin-left:auto}

.mbanner{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;border:1px solid var(--border);
  border-left:3px solid var(--warn);border-radius:8px;padding:10px 13px;margin-bottom:13px;
  font-size:12px;line-height:1.5;background:var(--panel)}
.mbanner.ok{border-left-color:var(--ok)}
.mbanner.demo{border-left-color:var(--accent)}
.mbanner code{background:var(--rail);border-radius:4px;padding:1px 5px}

.mband{fill:var(--rail);opacity:.3}
.mbandl{font-size:9.5px;fill:var(--faint);letter-spacing:.09em;text-transform:uppercase}
.munsourced .mbox{stroke-dasharray:5 4;stroke:var(--warn)}
.msource{color:var(--faint);font-size:11.5px}
.mnode{cursor:pointer}
.mnode .mbox{fill:var(--panel);stroke:var(--border);stroke-width:1.1}
.mnode:hover .mbox{stroke:var(--accent)}
.mnode.sel .mbox{stroke:var(--accent);stroke-width:2}
.mnode .mt{font-size:12px;font-weight:700;fill:var(--fg)}
.mnode .ms{font-size:10px;fill:var(--faint)}
.mnode .mr{font-size:10.5px;fill:var(--dim)}
.mnode .mr.pk{fill:var(--fg);font-weight:700}
.mnode .mr.fk{fill:var(--run)}
.mnode .mz{font-size:9.5px;fill:var(--faint)}
.k-app{fill:var(--accent)} .k-data{fill:var(--ok)} .k-queue{fill:var(--warn)}
.k-ext{fill:var(--faint)} .k-class{fill:var(--dim)} .k-port{fill:var(--rail)}
.mhttp{fill:var(--run)} .msql{fill:var(--ok)} .mqueue{fill:var(--warn)}
.mcall{fill:var(--rail)} .mfk{fill:var(--ok)} .mext{fill:var(--faint)}

/* Every one of these names TWO classes on purpose. This block is emitted before the flow graph's
   CSS, where .g-edge sets stroke to the rail colour with the same specificity a bare .m-sql has,
   so a single-class rule here loses to it and every edge on the map draws grey. It did. */
.g-edge.m-http{stroke:var(--run)}
.g-edge.m-sql{stroke:var(--ok)}
.g-edge.m-queue{stroke:var(--warn);stroke-dasharray:5 3}
.g-edge.m-ext{stroke:var(--faint);stroke-dasharray:2 3}
.g-edge.m-call{stroke:var(--rail)}
.g-edge.m-fk{stroke:var(--ok)}

/* Selection and hover. The whole point of the picture is seeing what one box touches, so the
   edges that touch it come forward and the rest go quiet. */
.g-edge{transition:opacity .13s ease,stroke-width .13s ease}
.g-edge.mdim{opacity:.09}
.g-edge.mhot{stroke:var(--accent);stroke-width:2.3;opacity:1}
.mnode .mbox{transition:stroke .13s ease,fill .13s ease}
.mnode.mfade{opacity:.35}
.mnode.mhot .mbox{stroke:var(--accent);stroke-width:2}
.mlabel{font-size:9.5px;fill:var(--faint);paint-order:stroke;stroke:var(--panel);stroke-width:3;
  stroke-linejoin:round}
.hide-http .m-http,.hide-sql .m-sql,.hide-queue .m-queue,.hide-call .m-call,
.hide-ext .m-ext,.hide-fk .m-fk{display:none}
.mpicks{display:flex;gap:4px;flex-wrap:wrap;margin:0 0 11px}
.mpicks a{font-size:11.5px;background:var(--bg);border:1px solid var(--border);border-radius:99px;
  color:var(--dim);padding:4px 12px;text-decoration:none;white-space:nowrap}
.mpicks a[aria-current="page"]{background:var(--accent);border-color:var(--accent);
  color:var(--on-accent);font-weight:700}
.mkey{display:flex;flex-wrap:wrap;gap:7px 15px;align-items:center;font-size:11.5px;color:var(--faint)}
.mkey label{display:inline-flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap}
.mkey input{accent-color:var(--accent);margin:0}
.mkey i{width:17px;height:0;border-top-width:2px;border-top-style:solid;display:inline-block}

.mfilters{display:flex;gap:10px;flex-wrap:wrap;font-size:11.5px;color:var(--dim)}
.mfilters label{display:inline-flex;align-items:center;gap:5px;cursor:pointer;white-space:nowrap}
.mfilters input{accent-color:var(--accent);margin:0}

.mcon{margin-top:14px}
.mctabs{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px}
.mctabs button{font:inherit;font-size:11.5px;background:var(--panel);border:1px solid var(--border);
  border-radius:99px;color:var(--dim);padding:4px 12px;cursor:pointer}
.mctabs button[aria-selected="true"]{background:var(--accent);border-color:var(--accent);
  color:var(--on-accent);font-weight:700}
.mcrow{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:9px}
.mcrow select,.mcrow input{font:inherit;font-size:12px;background:var(--bg);color:var(--fg);
  border:1px solid var(--border);border-radius:6px;padding:5px 8px;min-width:0;flex:1 1 180px}
.mcrow button{font:inherit;font-size:12px;font-weight:700;border-radius:7px;padding:6px 13px;
  cursor:pointer;background:var(--accent);color:var(--on-accent);border:1px solid var(--accent)}
.mcout{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:9px 11px;
  font-size:11.5px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;
  overflow:auto}
.mcout .bad{color:var(--bad)} .mcout .ok{color:var(--ok)}
.mchint{color:var(--faint);font-size:11px;margin:0 0 9px}
.mdl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:12px;align-items:baseline}
.mdl dt{color:var(--faint);font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}
.mdl dd{margin:0;min-width:0;overflow-wrap:anywhere}
.mdl dd.path{color:var(--run)}
.mempty{color:var(--faint);font-size:12px}
.mlimits{color:var(--faint);font-size:11px;line-height:1.6;margin-top:10px;padding-left:11px;
  border-left:2px solid var(--border)}
`;

const SCRIPT = `
  /* ---------------------------------------------------------------- the map */
  // The figure is fetched, not pushed: it is the only large thing on the page, it changes only
  // when somebody runs a map build, and it is needed on one view. The SSE frame carries the
  // summary the banner and the tab badge need, which is a few hundred bytes.
  var mapData = null;
  var mapFor = null;
  var mapSel = null;
  var mapHide = {};

  var MLEVELS = [
    { k: 'system', n: 'Whole system' },
    { k: 'flow', n: 'Business flow' },
    { k: 'modules', n: 'Modules' },
    { k: 'classes', n: 'Classes' }
  ];
  var MTIP = {
    system: 'Click the api box to open its modules.',
    flow: 'Each row is a part of the system. Read the steps left to right.',
    modules: 'Click a module to see the classes inside it.',
    classes: 'Every box is a declaration. The lines are imports, not calls.',
    er: 'Every box is a table. \\u25aa is a key, \\u2197 points at another table.'
  };

  function mapUrl(view, level, mod){
    var p = ['#' + (selected || '')];
    p.push(view);
    if (level) p.push(level);
    if (mod) p.push(mod);
    return p.join('/');
  }

  function fetchMap(){
    var want = selected || '';
    if (mapFor === want) return;
    mapFor = want;
    mapData = null;
    var url = '/api/map' + (selected ? '?project=' + encodeURIComponent(selected) : '');
    fetch(url, { headers: { accept: 'application/json' } })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){ if (mapFor === want){ mapData = d; draw(); } })
      .catch(function(){ if (mapFor === want){ mapData = { error: true }; draw(); } });
  }

  function mapBoxBody(n){
    var out = '';
    var y = n.y + 20;
    out += '<text class="mt" x="' + (n.x + 11) + '" y="' + y + '">' + esc(n.title) + '</text>';
    if (n.drill) out += '<text class="mz" x="' + (n.x + n.w - 11) + '" y="' + y + '" text-anchor="end">open</text>';
    y += 15;
    if (n.sub){ out += '<text class="ms" x="' + (n.x + 11) + '" y="' + y + '">' + esc(n.sub) + '</text>'; y += 15; }
    var rows = n.rows || [];
    for (var i = 0; i < rows.length; i++){
      y += 3;
      var flag = rows[i].flag ? ' ' + rows[i].flag : '';
      var mark = rows[i].flag === 'pk' ? '\\u25aa ' : rows[i].flag === 'fk' ? '\\u2197 ' : '';
      out += '<text class="mr' + flag + '" x="' + (n.x + 11) + '" y="' + y + '" xml:space="preserve">' +
        mark + esc(rows[i].t) + '</text>';
      y += 15;
    }
    return out;
  }

  function mapFigure(g, demo, viewId){
    return renderGraph(g, {
      view: 'map:' + (viewId || 'system'),
      label: 'project map',
      wrapClass: 'graph' + Object.keys(mapHide).map(function(k){ return mapHide[k] ? ' hide-' + k : ''; }).join(''),
      defs: '<marker id="mah-http" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">' +
            '<path class="mhttp" d="M0 0 L8 4 L0 8 z"></path></marker>' +
            '<marker id="mah-sql" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">' +
            '<path class="msql" d="M0 0 L8 4 L0 8 z"></path></marker>' +
            '<marker id="mah-queue" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">' +
            '<path class="mqueue" d="M0 0 L8 4 L0 8 z"></path></marker>' +
            '<marker id="mah-call" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">' +
            '<path class="mcall" d="M0 0 L8 4 L0 8 z"></path></marker>' +
            '<marker id="mah-fk" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">' +
            '<path class="mfk" d="M0 0 L8 4 L0 8 z"></path></marker>' +
            '<marker id="mah-ext" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">' +
            '<path class="mext" d="M0 0 L8 4 L0 8 z"></path></marker>' +
            (demo ? '<pattern id="mhatch" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
                    '<rect width="9" height="9" fill="none"></rect>' +
                    '<line x1="0" y1="0" x2="0" y2="9" stroke="var(--accent)" stroke-width="1.2" opacity="0.13"></line>' +
                    '</pattern>' : ''),
      legend: mapKey(MKINDS.filter(function(k){
        return g.edges.some(function(e){ return e.kind === k[0]; });
      })),
      edgeAttrs: function(e){ return ' data-a="' + esc(e.from) + '" data-b="' + esc(e.to) + '"'; },
      // Swimlanes sit under everything: they are the background a step is placed on, not a node.
      under: (g.bands || []).map(function(b){
        return '<rect class="mband" x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '" rx="6"></rect>' +
          '<text class="mbandl" x="' + (b.x + 8) + '" y="' + (b.y + b.h / 2 + 3) + '">' + esc(b.label) + '</text>';
      }).join(''),
      // A hatch over the whole figure, so a cropped screenshot of the demo still says it is one.
      after: demo ? '<rect x="0" y="0" width="' + g.width + '" height="' + g.height + '" fill="url(#mhatch)" pointer-events="none"></rect>' : '',
      edgeClass: function(e){
        var cls = 'g-edge m-' + e.kind;
        if (!mapSel) return cls;
        return cls + (e.from === mapSel || e.to === mapSel ? ' mhot' : ' mdim');
      },
      edgeMarker: function(e){ return 'mah-' + e.kind; },
      edgeLabel: function(e){ return e.label || ''; },
      nodeClass: function(n){
        var touches = mapSel && g.edges.some(function(e){
          return (e.from === mapSel && e.to === n.id) || (e.to === mapSel && e.from === n.id);
        });
        return 'mnode' + (mapSel === n.id ? ' sel' : '') + (n.unsourced ? ' munsourced' : '') +
          (mapSel && mapSel !== n.id && !touches ? ' mfade' : '') +
          (touches ? ' mhot' : '');
      },
      nodeAttrs: function(n){
        return ' data-node="' + esc(n.id) + '"' +
          (n.drill ? ' data-drill="' + esc(n.drill) + '"' : '') +
          (n.module ? ' data-module="' + esc(n.module) + '"' : '') +
          ' tabindex="0" role="button"';
      },
      nodeBox: function(n){
        return '<rect class="mbox" x="' + n.x + '" y="' + n.y + '" width="' + n.w + '" height="' + n.h + '" rx="7"></rect>' +
          '<rect class="k-' + esc(n.kind) + '" x="' + (n.x + 1) + '" y="' + (n.y + 1) + '" width="' + (n.w - 2) + '" height="3" rx="2"></rect>';
      },
      nodeBody: mapBoxBody
    });
  }

  function mapBanner(v){
    var m = v.map || {};
    if (m.demo || (mapData && mapData.demo)){
      return '<div class="mbanner demo"><div><b>This is keel\\u2019s bundled example, not your project.</b> ' +
        'Nothing here was read from your code. Run <code>keel map build</code> to map this one.</div></div>';
    }
    if (!m.present){
      return '<div class="mbanner"><div><b>No map has been built.</b> ' +
        'Run <code>keel map build</code>.</div></div>';
    }
    if (m.stale){
      return '<div class="mbanner"><div><b>\\u26a0 ' + esc(m.reason) + '.</b> ' +
        'What is drawn is what the sources said at <code>' + esc((m.sha || '').slice(0, 7)) + '</code>. ' +
        'Rebuild with <code>keel map build</code>.</div></div>';
    }
    return '<div class="mbanner ok"><div><b>\\u2713 The map matches HEAD</b> at <code>' +
      esc((m.sha || '').slice(0, 7)) + '</code>.</div></div>';
  }

  function mapDetail(){
    if (!mapData || !mapData.nodes) return '';
    var n = mapSel && mapData.nodes[mapSel];
    if (!n) return card('what is this box?', 'click any box', '<div class="mempty">Nothing selected yet.</div>');
    var rows = '<dt>kind</dt><dd>' + esc(n.kind) + '</dd>';
    if (n.role) rows += '<dt>role</dt><dd>' + esc(n.role) + '</dd>';
    if (n.module) rows += '<dt>module</dt><dd>' + esc(n.module) + '</dd>';
    if (n.operationId) rows += '<dt>operation</dt><dd>' + esc(n.operationId) + '</dd>';
    if (n.schedule) rows += '<dt>schedule</dt><dd>' + esc(n.schedule) + '</dd>';
    if (n.columns) rows += '<dt>columns</dt><dd>' + n.columns.map(function(c){ return esc(c.name); }).join(', ') + '</dd>';
    if (n.tests && n.tests.length) rows += '<dt>tests</dt><dd>' + n.tests.map(esc).join('<br>') + '</dd>';
    rows += '<dt>source</dt><dd class="path">' + (n.cite ? esc(n.cite.rel) + ':' + n.cite.line : 'derived, not from one file') + '</dd>';
    return card('what is this box?', esc(n.label), '<dl class="mdl">' + rows + '</dl>');
  }

  var MKINDS = [
    ['http', 'a web request', 'var(--run)', 'solid'],
    ['sql', 'reads or writes the database', 'var(--ok)', 'solid'],
    ['queue', 'a queue message', 'var(--warn)', 'dashed'],
    ['ext', 'another company', 'var(--faint)', 'dotted'],
    ['call', 'a call or an import', 'var(--rail)', 'solid'],
    ['fk', 'a foreign key', 'var(--ok)', 'solid']
  ];

  function mapKey(kinds){
    return '<div class="mkey">' + kinds.map(function(k){
      return '<label><input type="checkbox" data-mhide="' + k[0] + '"' + (mapHide[k[0]] ? '' : ' checked') + '>' +
        '<i style="border-color:' + k[2] + ';border-top-style:' + k[3] + '"></i>' + esc(k[1]) + '</label>';
    }).join('') + '<span>purple = what you picked, and everything it touches</span></div>';
  }

  // The console. Everything it can do is refused by default and refused again by the server, so
  // what the page does here is collect a key and show what came back — never build a command.
  var conTab = 'command';
  var conOut = null;

  function conBody(){
    var m = mapData || {};
    if (conTab === 'command'){
      // From the view frame, not the map. This read mapData.commands for two releases, and the map
      // has never emitted a commands key — so the selector always said "no commands are
      // configured" and this tab could not be used from the page even when it was turned on.
      var runnable = (last && last.runnable) || [];
      return '<p class="mchint">Runs a command or tool this project already defines. The page sends its key, never a string.</p>' +
        '<div class="mcrow"><select data-con="key">' +
        (runnable.length ? runnable.map(function(r){
          return '<option value="' + esc(r.key) + '">' + esc(r.key) + (r.kind === 'tool' ? '  (tool)' : '') + '</option>';
        }).join('') : '<option value="">no commands or tools are configured</option>') +
        '</select><button data-con-run="command">Run</button></div>';
    }
    if (conTab === 'endpoint'){
      var eps = Object.keys(m.nodes || {}).filter(function(id){ return m.nodes[id].kind === 'endpoint'; });
      return '<p class="mchint">Calls an endpoint the map knows, on the local stack only.</p>' +
        '<div class="mcrow"><select data-con="ep">' +
        eps.map(function(id){ return '<option value="' + esc(id) + '">' + esc(m.nodes[id].label) + '</option>'; }).join('') +
        '</select><button data-con-run="endpoint">Send</button></div>';
    }
    if (conTab === 'db'){
      return '<p class="mchint">One read, against a database keel can prove is local. There is no write mode.</p>' +
        '<div class="mcrow"><input data-con="sql" value="select 1" spellcheck="false">' +
        '<button data-con-run="db">Run</button></div>';
    }
    return '<p class="mchint">Puts a message on a queue, through a command this project defines.</p>' +
      '<div class="mcrow"><button data-con-run="queue">Publish</button></div>';
  }

  function renderConsole(){
    var tabs = [['command', 'Run a command'], ['endpoint', 'Call an endpoint'],
      ['db', 'Read the database'], ['queue', 'Send a queue message']];
    var body = '<div class="mctabs">' + tabs.map(function(t){
      return '<button data-con-tab="' + t[0] + '" aria-selected="' + (conTab === t[0]) + '">' + t[1] + '</button>';
    }).join('') + '</div>' + conBody() +
      '<div class="mcout">' + (conOut || 'Nothing run yet. Everything here is off until it is turned on in .keel/config.yml.') + '</div>';
    return '<div class="mcon">' + card('try it', 'against the running project', body) + '</div>';
  }

  function conSend(tab){
    var meta = document.querySelector('meta[name="keel-console"]');
    var body = { };
    if (tab === 'command'){ var k = app.querySelector('[data-con="key"]'); body.command = k ? k.value : ''; }
    if (tab === 'db'){ var q = app.querySelector('[data-con="sql"]'); body.sql = q ? q.value : ''; }
    if (tab === 'endpoint'){
      var sel = app.querySelector('[data-con="ep"]');
      var node = sel && mapData.nodes[sel.value];
      if (node){
        var bits = String(node.label).split(' ');
        body.method = bits[0];
        body.path = bits[1];
        body.knownPaths = Object.keys(mapData.nodes).filter(function(id){ return mapData.nodes[id].kind === 'endpoint'; })
          .map(function(id){ return String(mapData.nodes[id].label).split(' ')[1]; });
      }
    }
    conOut = 'Running\u2026';
    draw();
    fetch('/api/console/' + tab + (selected ? '?project=' + encodeURIComponent(selected) : ''), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-keel-console': meta ? meta.content : '' },
      body: JSON.stringify(body)
    }).then(function(r){ return r.json(); }).then(function(d){
      if (d && d.ok && d.result){
        conOut = '<span class="ok">ok</span>\\n' + esc(JSON.stringify(d.result, null, 1));
      } else {
        conOut = '<span class="bad">refused: ' + esc((d && d.error) || 'unknown') + '</span>' +
          (d && d.fix ? '\\n' + esc(d.fix) : '');
      }
      draw();
    }).catch(function(e){ conOut = '<span class="bad">' + esc(String(e)) + '</span>'; draw(); });
  }

  function renderMap(v, view, crumb){
    fetchMap();
    var level = view === 'er' ? 'er' : (crumb[0] || 'system');
    var mod = crumb[1] || null;
    if (!mapData) return card('map', 'reading', '<div class="mempty">Loading the map\\u2026</div>');
    if (mapData.error) return card('map', null, '<div class="bad">The map could not be read.</div>');

    var lv = mapData.levels[level];
    var g = null;
    var overflow = 0;
    var picks = null;
    if (level === 'classes'){
      picks = Object.keys((lv && lv.byModule) || {});
      if (!mod) mod = picks[0];
      var one = lv && lv.byModule && lv.byModule[mod];
      if (one){ g = one; overflow = one.overflow || 0; }
    } else if (level === 'flow' && lv && lv.byJourney){
      // One journey at a time. Three of them on one axis read as one twelve-step story, which is
      // what they are not: authoring a wave and submitting a score share no sequence.
      picks = Object.keys(lv.byJourney);
      if (!mod) mod = picks[0];
      g = lv.byJourney[mod] || null;
    } else {
      g = lv;
    }

    var levelNav = '<div class="mlevels">' + MLEVELS.map(function(L){
      return '<a href="' + mapUrl('map', L.k) + '"' + (view === 'map' && level === L.k ? ' aria-current="page"' : '') +
        '>' + esc(L.n) + '</a>';
    }).join('') + '<a href="' + mapUrl('er') + '"' + (view === 'er' ? ' aria-current="page"' : '') + '>Database</a></div>';

    var crumbs = '<div class="mcrumb"><a href="' + mapUrl('map', 'system') + '">' + esc(mapData.demo ? 'example' : (v.name || 'project')) + '</a>';
    if (view === 'er') crumbs += '<span class="sep">\\u25b8</span><span class="here">schema</span>';
    else {
      crumbs += '<span class="sep">\\u25b8</span>' + (level === 'system' ? '<span class="here">system</span>'
        : '<a href="' + mapUrl('map', 'modules') + '">modules</a>');
      if (level === 'classes' || level === 'flow') {
        if (level === 'flow') crumbs = '<div class="mcrumb"><a href="' + mapUrl('map', 'system') + '">' +
          esc(mapData.demo ? 'example' : (v.name || 'project')) + '</a><span class="sep">\\u25b8</span>' +
          '<span class="here">business flow</span>';
        if (mod) crumbs += '<span class="sep">\\u25b8</span><span class="here">' + esc(mod) + '</span>';
      }
    }
    crumbs += '</div>';

    var tag = mapData.counts
      ? mapData.counts.endpoints + ' endpoints \\u00b7 ' + mapData.counts.tables + ' tables \\u00b7 ' +
        mapData.counts.queues + ' queues \\u00b7 ' + mapData.counts.classes + ' declarations'
      : '';

    var picker = '';
    if (picks && picks.length > 1){
      picker = '<div class="mpicks">' + picks.map(function(k){
        return '<a href="' + mapUrl('map', level, k) + '"' + (k === mod ? ' aria-current="page"' : '') + '>' + esc(k) + '</a>';
      }).join('') + '</div>';
    }

    var body;
    if (!g || !g.nodes || !g.nodes.length){
      body = '<div class="mempty">' + esc((g && g.empty) || ('Nothing to draw at this level' + (mod ? ' for ' + mod : '') + '.')) + '</div>';
    } else {
      body = mapFigure(g, Boolean(mapData.demo), level + (mod ? ':' + mod : ''));
      if (g.source) body += '<div class="msource">Steps read from ' + esc(g.source) + '. A dashed box is a step with no citation behind it.</div>';
      if (overflow) body += note(overflow + ' more declaration(s) in this module are not drawn.');
    }

    var limits = '<div class="mlimits">' + (mapData.limits || []).map(esc).join('<br>') +
      ((mapData.sources && mapData.sources.skipped || []).length
        ? '<br>Not read: ' + mapData.sources.skipped.map(esc).join('; ') : '') + '</div>';

    return mapBanner(v) +
      '<div class="mbar">' + levelNav + crumbs + '<span class="mtip">' + esc(MTIP[level] || '') + '</span></div>' +
      card('map', tag, picker + body + limits) +
      mapDetail() +
      renderConsole();
  }
`;

module.exports = { CSS, SCRIPT };
