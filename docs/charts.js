// Small dependency-free SVG chart kit used by the analysis pages.
//
// Every chart is a card with a title, optional subtitle/legend, the plot, and
// a "Table" toggle that swaps the plot for the same numbers as a table, so no
// value is only reachable by hovering. Marks are focusable and show the same
// tooltip on keyboard focus as on hover. Charts redraw at the card's real
// width (ResizeObserver) so text never scales down on narrow screens.
//
// Colors were checked with the dataviz palette validator against the white
// card surface: single series use SERIES[0]; the savings chart's two lines use
// SERIES[0..1] (adjacent CVD dE 24.7); income tiers use TIER_RAMP, an ordinal
// one-hue ramp (monotone lightness, light end 2.11:1). The site's own page
// accents read as gray at chart scale, so they stay on UI chrome only.
const Charts = (()=>{
  const NS = 'http://www.w3.org/2000/svg';
  const SERIES = ['#2a78d6', '#eb6834'];
  const TIER_RAMP = ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281'];
  const INK = { text: '#5A574D', muted: '#757164', grid: '#ECE9E1', axis: '#C9C3B4', surface: '#FFFFFF' };
  const FONT = 11;

  function svgEl(tag, attrs, parent){
    const e = document.createElementNS(NS, tag);
    for(const k in attrs) e.setAttribute(k, attrs[k]);
    if(parent) parent.appendChild(e);
    return e;
  }
  function label(parent, x, y, str, attrs){
    const t = svgEl('text', Object.assign({ x, y, fill: INK.text, 'font-size': FONT }, attrs || {}), parent);
    t.textContent = str;
    return t;
  }
  // Rough width of a label at FONT px; good enough to space ticks and truncate.
  const textW = s => String(s).length * FONT * 0.58;
  function fit(s, maxW){
    s = String(s);
    if(textW(s) <= maxW) return s;
    let out = s;
    while(out.length > 1 && textW(out + '…') > maxW) out = out.slice(0, -1);
    return out + '…';
  }

  function niceTicks(max, count){
    count = count || 4;
    if(!(max > 0)) return [0, 1];
    const raw = max / count, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m=>m*mag).find(s=>s >= raw);
    const ticks = [];
    for(let v=0; v <= max + step*0.999; v += step) ticks.push(+v.toFixed(10));
    return ticks;
  }
  function compact(v){
    const a = Math.abs(v);
    if(a >= 1e6) return (v/1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if(a >= 1e4) return Math.round(v/1e3) + 'K';
    return v.toLocaleString('en-US');
  }

  // Bars: 4px rounded data-end, square at the baseline.
  function colPath(x, y0, w, y1){
    const r = Math.min(4, w/2, y0 - y1);
    return `M${x},${y0}V${y1+r}Q${x},${y1} ${x+r},${y1}H${x+w-r}Q${x+w},${y1} ${x+w},${y1+r}V${y0}Z`;
  }
  function barPath(x0, y, x1, h, rounded){
    const r = rounded === false ? 0 : Math.min(4, h/2, x1 - x0);
    return `M${x0},${y}H${x1-r}Q${x1},${y} ${x1},${y+r}V${y+h-r}Q${x1},${y+h} ${x1-r},${y+h}H${x0}Z`;
  }

  /* ---------- tooltip (one per page; text only, never innerHTML) ---------- */
  let tipEl = null;
  function tip(){
    if(!tipEl){
      tipEl = document.createElement('div');
      tipEl.className = 'chart-tip';
      tipEl.setAttribute('role', 'status');
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }
  // rows: [{ value, label, color }] -- value leads, label follows.
  function showTip(x, y, title, rows){
    const t = tip();
    t.replaceChildren();
    if(title){
      const h = document.createElement('div');
      h.className = 'chart-tip-title';
      h.textContent = title;
      t.appendChild(h);
    }
    rows.forEach(r=>{
      const row = document.createElement('div');
      row.className = 'chart-tip-row';
      if(r.color){
        const k = document.createElement('span');
        k.className = 'chart-tip-key';
        k.style.background = r.color;
        row.appendChild(k);
      }
      const v = document.createElement('strong');
      v.textContent = r.value;
      row.appendChild(v);
      if(r.label){
        const l = document.createElement('span');
        l.className = 'chart-tip-label';
        l.textContent = r.label;
        row.appendChild(l);
      }
      t.appendChild(row);
    });
    t.style.display = 'block';
    const w = t.offsetWidth, h = t.offsetHeight;
    let left = x + 12, top = y - h - 12;
    if(left + w > window.innerWidth - 8) left = x - w - 12;
    if(left < 8) left = 8;
    if(top < 8) top = y + 16;
    t.style.left = left + 'px';
    t.style.top = top + 'px';
  }
  function hideTip(){ if(tipEl) tipEl.style.display = 'none'; }

  // Hover + focus wiring for a mark whose hit target is `hit` (bigger than the
  // painted mark). `lift` gets a class while active so the mark responds.
  function bindMark(hit, lift, title, rows, ariaLabel){
    hit.setAttribute('tabindex', '0');
    hit.setAttribute('role', 'img');
    hit.setAttribute('aria-label', ariaLabel);
    const on = e=>{
      if(lift) lift.classList.add('is-active');
      const b = hit.getBoundingClientRect();
      const x = e && e.clientX != null ? e.clientX : b.left + b.width/2;
      const y = e && e.clientY != null ? e.clientY : b.top;
      showTip(x, y, title, rows);
    };
    const off = ()=>{ if(lift) lift.classList.remove('is-active'); hideTip(); };
    hit.addEventListener('pointermove', on);
    hit.addEventListener('pointerleave', off);
    hit.addEventListener('focus', ()=>on());
    hit.addEventListener('blur', off);
  }

  /* ---------- card shell: title, sub, legend, plot, table toggle ---------- */
  function card(container, o){
    if(container._ro) container._ro.disconnect();
    container.replaceChildren();
    container.classList.add('chart-card');

    const head = document.createElement('div');
    head.className = 'chart-head';
    const h = document.createElement('p');
    h.className = 'chart-title';
    h.textContent = o.title;
    head.appendChild(h);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'chart-toggle';
    toggle.textContent = 'Table';
    head.appendChild(toggle);
    container.appendChild(head);

    if(o.sub){
      const s = document.createElement('p');
      s.className = 'chart-sub';
      s.textContent = o.sub;
      container.appendChild(s);
    }
    if(o.legend && o.legend.length >= 2){
      const lg = document.createElement('div');
      lg.className = 'chart-legend';
      o.legend.forEach(item=>{
        const it = document.createElement('span');
        it.className = 'chart-legend-item';
        const sw = document.createElement('span');
        sw.className = 'chart-swatch' + (item.shape === 'line' ? ' is-line' : '');
        sw.style.background = item.color;
        it.appendChild(sw);
        it.appendChild(document.createTextNode(item.name));
        lg.appendChild(it);
      });
      container.appendChild(lg);
    }

    const plot = document.createElement('div');
    plot.className = 'chart-plot';
    container.appendChild(plot);

    const tableWrap = document.createElement('div');
    tableWrap.className = 'chart-table';
    tableWrap.hidden = true;
    const table = document.createElement('table');
    table.className = 'neighborhood-table';
    const thead = table.createTHead().insertRow();
    o.table.head.forEach(c=>{ const th = document.createElement('th'); th.textContent = c; thead.appendChild(th); });
    const tbody = table.createTBody();
    o.table.rows.forEach(r=>{
      const tr = tbody.insertRow();
      r.forEach(c=>{ tr.insertCell().textContent = c; });
    });
    tableWrap.appendChild(table);
    container.appendChild(tableWrap);

    toggle.onclick = ()=>{
      const showTable = tableWrap.hidden;
      tableWrap.hidden = !showTable;
      plot.hidden = showTable;
      toggle.textContent = showTable ? 'Chart' : 'Table';
      toggle.setAttribute('aria-pressed', String(showTable));
    };
    return plot;
  }

  // Draw at the plot's real width, and again whenever it changes.
  function mount(container, plot, title, draw){
    let lastW = 0;
    const render = ()=>{
      const w = Math.floor(plot.clientWidth);
      if(!w || w === lastW) return;
      lastW = w;
      hideTip();
      plot.replaceChildren();
      const svg = draw(w);
      svg.setAttribute('role', 'group');
      svg.setAttribute('aria-label', title);
      plot.appendChild(svg);
    };
    container._ro = new ResizeObserver(()=>requestAnimationFrame(render));
    container._ro.observe(plot);
    render();
  }

  function yAxis(svg, m, W, ph, ticks, fmt){
    const top = ticks[ticks.length-1];
    const y = v => m.t + ph - (v/top)*ph;
    ticks.forEach((v, i)=>{
      if(i > 0) svgEl('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: INK.grid, 'stroke-width': 1, 'shape-rendering': 'crispEdges' }, svg);
      label(svg, m.l - 6, y(v) + 4, fmt(v), { 'text-anchor': 'end', fill: INK.muted, class: 'tnum' });
    });
    svgEl('line', { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), stroke: INK.axis, 'stroke-width': 1, 'shape-rendering': 'crispEdges' }, svg);
    return y;
  }

  /* ---------- vertical columns (time buckets, histograms, weekdays) ----------
     o: { title, sub, rows:[{label, value, tipTitle?}], fmt, axisFmt?, height?,
          labelHead?, valueHead?, color? } */
  function columns(container, o){
    const fmt = o.fmt || (v=>v.toLocaleString('en-US'));
    const axisFmt = o.axisFmt || compact;
    const plot = card(container, {
      title: o.title, sub: o.sub,
      table: { head: [o.labelHead || '', o.valueHead || 'Value'], rows: o.rows.map(r=>[r.tipTitle || r.label, fmt(r.value)]) },
    });
    mount(container, plot, o.title, W=>{
      const H = o.height || 190;
      const max = Math.max(0, ...o.rows.map(r=>r.value));
      const ticks = niceTicks(max);
      const m = { t: 18, r: 6, b: 24, l: Math.max(...ticks.map(v=>textW(axisFmt(v)))) + 10 };
      const pw = W - m.l - m.r, ph = H - m.t - m.b;
      const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
      const y = yAxis(svg, m, W, ph, ticks, axisFmt);
      const n = o.rows.length, band = pw / n;
      const bw = Math.max(1, Math.min(24, band*0.72, band - 2));
      const every = Math.max(1, Math.ceil((Math.max(...o.rows.map(r=>textW(r.label))) + 8) / band));
      const maxIdx = o.rows.reduce((bi, r, i)=> r.value > o.rows[bi].value ? i : bi, 0);
      o.rows.forEach((r, i)=>{
        const cx = m.l + band*i + band/2;
        const g = svgEl('g', {}, svg);
        let mark = null;
        if(r.value > 0){
          mark = svgEl('path', { d: colPath(cx - bw/2, y(0), bw, y(r.value)), fill: o.color || SERIES[0], class: 'chart-mark' }, g);
        }
        // Direct label on the tallest column only; the rest live in the axis, tooltip and table.
        if(i === maxIdx && r.value > 0){
          label(g, cx, y(r.value) - 5, fmt(r.value), { 'text-anchor': 'middle', fill: '#1C1B19', 'font-weight': 600 });
        }
        if(i % every === 0 || n <= 8){
          label(svg, cx, H - m.b + 15, r.label, { 'text-anchor': 'middle', fill: INK.muted });
        }
        const hit = svgEl('rect', { x: m.l + band*i, y: m.t, width: band, height: ph + 4, fill: 'transparent', class: 'chart-hit' }, g);
        const name = r.tipTitle || r.label;
        bindMark(hit, mark, name, [{ value: fmt(r.value), label: o.valueHead || '' }], `${name}: ${fmt(r.value)}`);
      });
      return svg;
    });
  }

  /* ---------- horizontal ranked bars, value at each tip ----------
     o: { title, sub, rows:[{label, value, color?, tipTitle?}], fmt, labelHead?, valueHead? } */
  function bars(container, o){
    const fmt = o.fmt || (v=>v.toLocaleString('en-US'));
    const plot = card(container, {
      title: o.title, sub: o.sub,
      table: { head: [o.labelHead || '', o.valueHead || 'Value'], rows: o.rows.map(r=>[r.tipTitle || r.label, fmt(r.value)]) },
    });
    mount(container, plot, o.title, W=>{
      const rowH = 28, thick = 16;
      const H = o.rows.length * rowH + 4;
      const labelW = Math.min(W*0.42, Math.max(...o.rows.map(r=>textW(r.label))) + 4);
      const valW = Math.max(...o.rows.map(r=>textW(fmt(r.value)))) + 10;
      const x0 = labelW + 10, span = Math.max(10, W - x0 - valW);
      const max = Math.max(1e-9, ...o.rows.map(r=>r.value));
      const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
      svgEl('line', { x1: x0, x2: x0, y1: 0, y2: H, stroke: INK.axis, 'stroke-width': 1, 'shape-rendering': 'crispEdges' }, svg);
      o.rows.forEach((r, i)=>{
        const yTop = i*rowH + (rowH - thick)/2 + 2;
        const g = svgEl('g', {}, svg);
        label(g, labelW, yTop + thick/2 + 4, fit(r.label, labelW), { 'text-anchor': 'end' });
        const x1 = x0 + (r.value/max)*span;
        let mark = null;
        if(r.value > 0) mark = svgEl('path', { d: barPath(x0, yTop, x1, thick), fill: r.color || o.color || SERIES[0], class: 'chart-mark' }, g);
        label(g, (r.value > 0 ? x1 : x0) + 6, yTop + thick/2 + 4, fmt(r.value), { fill: '#1C1B19', class: 'tnum' });
        const hit = svgEl('rect', { x: 0, y: i*rowH, width: W, height: rowH, fill: 'transparent', class: 'chart-hit' }, g);
        const name = r.tipTitle || r.label;
        bindMark(hit, mark, name, [{ value: fmt(r.value), label: o.valueHead || '', color: r.color }], `${name}: ${fmt(r.value)}`);
      });
      return svg;
    });
  }

  /* ---------- horizontal stacked bars (one whole per row, split by series) ----------
     o: { title, sub, series:[{name, color}], rows:[{label, values:[...], extra?}],
          fmt, labelHead?, extraHead? } */
  function stackedBars(container, o){
    const fmt = o.fmt || (v=>v.toLocaleString('en-US'));
    const total = r => r.values.reduce((s,v)=>s+v, 0);
    const head = [o.labelHead || ''];
    if(o.extraHead) head.push(o.extraHead);
    head.push(...o.series.map(s=>s.name), 'Total');
    const plot = card(container, {
      title: o.title, sub: o.sub,
      legend: o.series.map(s=>({ name: s.name, color: s.color })),
      table: { head, rows: o.rows.map(r=>[r.label, ...(o.extraHead ? [String(r.extra)] : []), ...r.values.map(fmt), fmt(total(r))]) },
    });
    mount(container, plot, o.title, W=>{
      const rowH = 30, thick = 18, gap = 2;
      const H = o.rows.length * rowH + 4;
      const labelW = Math.min(W*0.38, Math.max(...o.rows.map(r=>textW(r.label))) + 4);
      const valW = Math.max(...o.rows.map(r=>textW(fmt(total(r))))) + 10;
      const x0 = labelW + 10, span = Math.max(10, W - x0 - valW);
      const max = Math.max(1e-9, ...o.rows.map(total));
      const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
      svgEl('line', { x1: x0, x2: x0, y1: 0, y2: H, stroke: INK.axis, 'stroke-width': 1, 'shape-rendering': 'crispEdges' }, svg);
      o.rows.forEach((r, i)=>{
        const yTop = i*rowH + (rowH - thick)/2 + 2;
        const g = svgEl('g', { class: 'chart-stack' }, svg);
        label(g, labelW, yTop + thick/2 + 4, fit(r.label, labelW), { 'text-anchor': 'end' });
        const nonZero = r.values.map((v, k)=>[v, k]).filter(([v])=>v > 0);
        let x = x0;
        nonZero.forEach(([v, k], j)=>{
          const w = (v/max)*span;
          const last = j === nonZero.length - 1;
          // 2px surface gap between touching segments; only the row's data-end is rounded.
          const drawW = Math.max(0.5, last ? w : w - gap);
          svgEl('path', { d: barPath(x, yTop, x + drawW, thick, last), fill: o.series[k].color }, g);
          x += w;
        });
        label(g, x + 6, yTop + thick/2 + 4, fmt(total(r)), { fill: '#1C1B19', class: 'tnum' });
        const hit = svgEl('rect', { x: 0, y: i*rowH, width: W, height: rowH, fill: 'transparent', class: 'chart-hit' }, g);
        const rows = nonZero.map(([v, k])=>({ value: fmt(v), label: o.series[k].name, color: o.series[k].color }));
        rows.push({ value: fmt(total(r)), label: 'Total' });
        bindMark(hit, g, r.label, rows, `${r.label}: ${fmt(total(r))} total`);
      });
      return svg;
    });
  }

  /* ---------- line chart with crosshair ----------
     o: { title, sub, labels:[...], series:[{name, values, color}], fmt, axisFmt?,
          area?: bool (single series wash), refLine?: {value, label}, height?, labelHead? } */
  function line(container, o){
    const fmt = o.fmt || (v=>v.toLocaleString('en-US'));
    const axisFmt = o.axisFmt || compact;
    const plot = card(container, {
      title: o.title, sub: o.sub,
      legend: o.series.map(s=>({ name: s.name, color: s.color, shape: 'line' })),
      table: { head: [o.labelHead || '', ...o.series.map(s=>s.name)], rows: o.labels.map((l, i)=>[l, ...o.series.map(s=>fmt(s.values[i]))]) },
    });
    mount(container, plot, o.title, W=>{
      const H = o.height || 210;
      const all = o.series.flatMap(s=>s.values).concat(o.refLine ? [o.refLine.value] : []);
      const ticks = niceTicks(Math.max(0, ...all));
      const endW = Math.max(...o.series.map(s=>textW(fmt(s.values[s.values.length-1])))) + 10;
      const m = { t: 14, r: endW, b: 24, l: Math.max(...ticks.map(v=>textW(axisFmt(v)))) + 10 };
      const pw = W - m.l - m.r, ph = H - m.t - m.b;
      const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
      const y = yAxis(svg, m, W, ph, ticks, axisFmt);
      const n = o.labels.length;
      const step = n > 1 ? pw/(n-1) : 0;
      const x = i => m.l + (n > 1 ? step*i : pw/2);

      // Centered under each point, clamped inside the plot; a label that would
      // overlap the previous one is skipped (tooltip and table still have it).
      const every = Math.max(1, Math.ceil((Math.max(...o.labels.map(l=>textW(l))) + 10) / Math.max(step, 1)));
      let lastRight = -Infinity;
      o.labels.forEach((l, i)=>{
        if(i % every !== 0) return;
        const w = textW(l);
        const cx = Math.min(Math.max(x(i), w/2), W - w/2);
        if(cx - w/2 < lastRight + 6) return;
        lastRight = cx + w/2;
        label(svg, cx, H - m.b + 15, l, { 'text-anchor': 'middle', fill: INK.muted });
      });

      if(o.refLine){
        const ry = y(o.refLine.value);
        svgEl('line', { x1: m.l, x2: W - m.r, y1: ry, y2: ry, stroke: '#8A8577', 'stroke-width': 1, 'shape-rendering': 'crispEdges' }, svg);
        label(svg, m.l + 4, ry - 5, o.refLine.label, { fill: INK.text });
      }

      const ends = [];
      o.series.forEach(s=>{
        const pts = s.values.map((v, i)=>`${x(i)},${y(v)}`);
        if(o.area && o.series.length === 1){
          svgEl('path', { d: `M${x(0)},${y(0)}L${pts.join('L')}L${x(n-1)},${y(0)}Z`, fill: s.color, 'fill-opacity': 0.1 }, svg);
        }
        svgEl('path', { d: 'M' + pts.join('L'), fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
        ends.push({ y: y(s.values[n-1]), text: fmt(s.values[n-1]), color: s.color });
      });
      // End labels; skip one that would collide with an earlier one (legend + tooltip carry it).
      const placed = [];
      ends.forEach(e=>{
        if(placed.some(p=>Math.abs(p - e.y) < 13)) return;
        placed.push(e.y);
        svgEl('circle', { cx: x(n-1), cy: e.y, r: 4, fill: e.color, stroke: INK.surface, 'stroke-width': 2 }, svg);
        label(svg, x(n-1) + 8, e.y + 4, e.text, { fill: '#1C1B19', 'font-weight': 600, class: 'tnum' });
      });

      // Crosshair layer: snaps to the nearest x; arrow keys move it when focused.
      const cross = svgEl('g', { class: 'chart-cross', visibility: 'hidden' }, svg);
      const vline = svgEl('line', { y1: m.t, y2: m.t + ph, stroke: '#8A8577', 'stroke-width': 1 }, cross);
      const dots = o.series.map(s=>svgEl('circle', { r: 4, fill: s.color, stroke: INK.surface, 'stroke-width': 2 }, cross));
      const hit = svgEl('rect', { x: m.l - 6, y: m.t, width: pw + 12, height: ph, fill: 'transparent', class: 'chart-hit', tabindex: 0, role: 'img',
        'aria-label': `${o.title}. Use left and right arrow keys to read values.` }, svg);
      let idx = n - 1;
      const show = (cx, cy)=>{
        vline.setAttribute('x1', x(idx)); vline.setAttribute('x2', x(idx));
        o.series.forEach((s, k)=>{ dots[k].setAttribute('cx', x(idx)); dots[k].setAttribute('cy', y(s.values[idx])); });
        cross.setAttribute('visibility', 'visible');
        const b = svg.getBoundingClientRect();
        showTip(cx != null ? cx : b.left + x(idx), cy != null ? cy : b.top + y(o.series[0].values[idx]), o.labels[idx],
          o.series.map(s=>({ value: fmt(s.values[idx]), label: o.series.length > 1 ? s.name : '', color: s.color })));
      };
      const hide = ()=>{ cross.setAttribute('visibility', 'hidden'); hideTip(); };
      hit.addEventListener('pointermove', e=>{
        const b = svg.getBoundingClientRect();
        idx = n > 1 ? Math.max(0, Math.min(n-1, Math.round((e.clientX - b.left - m.l)/step))) : 0;
        show(e.clientX, e.clientY);
      });
      hit.addEventListener('pointerleave', hide);
      hit.addEventListener('focus', ()=>show());
      hit.addEventListener('blur', hide);
      hit.addEventListener('keydown', e=>{
        if(e.key === 'ArrowLeft'){ idx = Math.max(0, idx-1); show(); e.preventDefault(); }
        if(e.key === 'ArrowRight'){ idx = Math.min(n-1, idx+1); show(); e.preventDefault(); }
      });
      return svg;
    });
  }

  /* ---------- min / median / max per row on one shared axis ----------
     o: { title, sub, rows:[{label, min, med, max, n}], fmt, axisFmt?, labelHead?, extraCols? } */
  function range(container, o){
    const fmt = o.fmt || (v=>v.toLocaleString('en-US'));
    const axisFmt = o.axisFmt || compact;
    const extra = o.extraCols || [];
    const plot = card(container, {
      title: o.title, sub: o.sub,
      table: {
        head: [o.labelHead || '', 'Units', 'Min', 'Median', 'Max', ...extra.map(c=>c.head)],
        rows: o.rows.map(r=>[r.label, String(r.n), fmt(r.min), fmt(r.med), fmt(r.max), ...extra.map(c=>c.value(r))]),
      },
    });
    mount(container, plot, o.title, W=>{
      const rowH = 32;
      const labelW = Math.max(...o.rows.map(r=>textW(r.label))) + 4;
      const lo = Math.min(...o.rows.map(r=>r.min)), hi = Math.max(...o.rows.map(r=>r.max));
      const ticks = niceTicks(hi);
      const start = ticks.filter(t=>t <= lo).pop() || 0;
      const top = ticks[ticks.length-1];
      const axisTicks = ticks.filter(t=>t >= start);
      const m = { l: labelW + 14, r: 18, t: 4, b: 22 };
      const H = o.rows.length*rowH + m.t + m.b;
      const pw = W - m.l - m.r;
      const x = v => m.l + ((v - start)/(top - start || 1))*pw;
      const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
      const every = Math.max(1, Math.ceil((Math.max(...axisTicks.map(t=>textW(axisFmt(t)))) + 12) / (pw/Math.max(1, axisTicks.length-1))));
      axisTicks.forEach((t, i)=>{
        svgEl('line', { x1: x(t), x2: x(t), y1: m.t, y2: H - m.b, stroke: INK.grid, 'stroke-width': 1, 'shape-rendering': 'crispEdges' }, svg);
        if(i % every === 0) label(svg, x(t), H - m.b + 15, axisFmt(t), { 'text-anchor': 'middle', fill: INK.muted, class: 'tnum' });
      });
      o.rows.forEach((r, i)=>{
        const cy = m.t + i*rowH + rowH/2;
        const g = svgEl('g', {}, svg);
        label(g, labelW, cy + 4, r.label, { 'text-anchor': 'end' });
        svgEl('line', { x1: x(r.min), x2: x(r.max), y1: cy, y2: cy, stroke: SERIES[0], 'stroke-opacity': 0.35, 'stroke-width': 6, 'stroke-linecap': 'round' }, g);
        const dot = svgEl('circle', { cx: x(r.med), cy, r: 5, fill: SERIES[0], stroke: INK.surface, 'stroke-width': 2, class: 'chart-mark' }, g);
        const hit = svgEl('rect', { x: 0, y: cy - rowH/2, width: W, height: rowH, fill: 'transparent', class: 'chart-hit' }, g);
        bindMark(hit, dot, `${r.label} · ${r.n} ${r.n === 1 ? 'unit' : 'units'}`, [
          { value: fmt(r.med), label: 'median' }, { value: fmt(r.min), label: 'lowest' }, { value: fmt(r.max), label: 'highest' },
        ], `${r.label}: median ${fmt(r.med)}, from ${fmt(r.min)} to ${fmt(r.max)}`);
      });
      return svg;
    });
  }

  // Bins values into equal-width buckets on a "nice" step. Returns [{lo, hi, count}].
  function histogram(values, targetBins){
    if(!values.length) return [];
    const lo = Math.min(...values), hi = Math.max(...values);
    const raw = Math.max(1, (hi - lo) / (targetBins || 8));
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(k=>k*mag).find(s=>s >= raw);
    const start = Math.floor(lo/step)*step;
    const bins = [];
    for(let b = start; b <= hi; b += step) bins.push({ lo: b, hi: b + step, count: 0 });
    values.forEach(v=>{ bins[Math.min(bins.length-1, Math.floor((v - start)/step))].count++; });
    return bins;
  }

  return { SERIES, TIER_RAMP, columns, bars, stackedBars, line, range, histogram };
})();
