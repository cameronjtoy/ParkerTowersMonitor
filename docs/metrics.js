// Monitor Metrics page (metrics.html): computed in the browser from the
// rental `listings` table. Helpers are in common.js, charts in charts.js.
const DAY = 86400000;

async function loadMetrics(){
  const { data, error } = await supabaseClient
    .from('listings')
    .select('property,price,beds,sqft,first_seen,last_seen,active');
  if(error){
    document.getElementById('metricsLoading').textContent = 'Could not load listings: ' + error.message;
    return;
  }
  document.getElementById('metricsLoading').style.display = 'none';
  renderMetrics(data || []);
}

const bedLabel = b => b==null ? 'Unknown' : (b===0 ? 'Studio' : (b>=3 ? '3+ BD' : b + ' BD'));
const BED_ORDER = ['Studio', '1 BD', '2 BD', '3+ BD', 'Unknown'];

function statTile(value, label){
  const card = document.createElement('div');
  card.className = 'stat-card';
  const v = document.createElement('div');
  v.className = 'stat-value';
  v.textContent = value;
  const l = document.createElement('div');
  l.className = 'stat-label';
  l.textContent = label;
  card.append(v, l);
  return card;
}

function renderMetrics(all){
  const tiles = document.getElementById('metricsTiles');
  if(!all.length){
    tiles.replaceChildren();
    document.getElementById('metricsEmpty').style.display = 'block';
    return;
  }

  const active = all.filter(l=>l.active);
  const delisted = all.filter(l=>!l.active);
  const listedDays = l => (new Date(l.last_seen) - new Date(l.first_seen)) / DAY;

  // Last 30 ET calendar days, oldest first.
  const days = [];
  for(let i=29; i>=0; i--) days.push(etDay(Date.now() - i*DAY));

  const perDay = {};
  all.forEach(l=>{ const d = etDay(l.first_seen); perDay[d] = (perDay[d]||0) + 1; });
  const last7 = days.slice(-7).reduce((n,d)=> n + (perDay[d]||0), 0);
  const prev7 = days.slice(-14, -7).reduce((n,d)=> n + (perDay[d]||0), 0);

  const firstSeen = Math.min(...all.map(l=>new Date(l.first_seen).getTime()));
  const spanDays = Math.max(1, Math.ceil((Date.now() - firstSeen)/DAY));
  const medianListedDelisted = median(delisted.map(listedDays));
  const quick = delisted.filter(l=> listedDays(l) < 1).length;

  const trend = prev7===0 ? '' : ` (${last7>=prev7 ? '+' : ''}${Math.round((last7-prev7)/prev7*100)}% vs prior 7d)`;
  tiles.replaceChildren(
    statTile(fmtNum(all.length), 'Listings tracked, all time'),
    statTile(fmtNum(active.length), 'Currently active'),
    statTile((all.length/spanDays).toFixed(1), `New listings / day (avg over ${spanDays}d)`),
    statTile(fmtNum(last7), 'New in last 7 days' + trend),
    statTile(fmtDays(medianListedDelisted), 'Median time listed (delisted units)'),
    statTile(delisted.length ? Math.round(quick/delisted.length*100) + '%' : '—', 'Delisted within 24h of first seen'),
  );

  // Inventory on each day: units first seen on/before it and last seen on/after it.
  const spans = all.map(l=>[etDay(l.first_seen), etDay(l.last_seen)]);
  Charts.line(document.getElementById('chartInventory'), {
    title: 'Active listings over time',
    sub: 'Units on the market each day, last 30 days (ET)',
    labels: days.map(shortDay),
    series: [{ name: 'Active listings', values: days.map(d=>spans.filter(([f, l])=>f <= d && l >= d).length), color: Charts.SERIES[0] }],
    area: true, fmt: v=>fmtNum(v), axisFmt: v=>String(v), labelHead: 'Day',
  });

  Charts.columns(document.getElementById('chartNewPerDay'), {
    title: 'New listings per day',
    sub: 'Last 30 days (ET)',
    rows: days.map(d=>({ label: shortDay(d), value: perDay[d]||0 })),
    fmt: v=>String(v), axisFmt: v=>String(v), labelHead: 'Day', valueHead: 'New listings',
  });

  const wdNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const wdCount = [0,0,0,0,0,0,0], wdSeen = [0,0,0,0,0,0,0];
  all.forEach(l=>{ wdCount[new Date(etDay(l.first_seen) + 'T12:00:00').getDay()]++; });
  for(let i=0; i<spanDays; i++) wdSeen[new Date(etDay(Date.now() - i*DAY) + 'T12:00:00').getDay()]++;
  Charts.columns(document.getElementById('chartWeekday'), {
    title: 'Average new listings by weekday',
    sub: 'Averaged over every occurrence of that weekday since the first listing was recorded',
    rows: wdNames.map((n, i)=>({ label: n, value: wdSeen[i] ? +(wdCount[i]/wdSeen[i]).toFixed(1) : 0 })),
    fmt: v=>v.toFixed(1) + '/day', axisFmt: v=>String(v), labelHead: 'Weekday', valueHead: 'Avg new / day',
  });

  const byProp = {};
  active.forEach(l=>{ byProp[l.property] = (byProp[l.property]||0) + 1; });
  Charts.bars(document.getElementById('chartByProperty'), {
    title: 'Active listings by property',
    rows: Object.entries(byProp).map(([p, n])=>({ label: p, value: n })).sort((a,b)=>b.value - a.value),
    fmt: v=>String(v), labelHead: 'Property', valueHead: 'Active listings',
  });

  const byBed = {};
  active.forEach(l=>{ (byBed[bedLabel(l.beds)] = byBed[bedLabel(l.beds)] || []).push(l); });
  Charts.range(document.getElementById('chartRentBySize'), {
    title: 'Active asking rent by size',
    sub: 'Lowest to highest, dot marks the median',
    rows: BED_ORDER.filter(k=>byBed[k]).map(k=>{
      const ps = byBed[k].map(l=>l.price);
      return { label: k, n: ps.length, min: Math.min(...ps), med: median(ps), max: Math.max(...ps), units: byBed[k] };
    }),
    fmt: fmtPrice, axisFmt: fmtMoneyCompact, labelHead: 'Size',
    extraCols: [{ head: '$/ft² (med.)', value: r=>{
      const sq = r.units.filter(l=>l.sqft).map(l=>l.price/l.sqft);
      return sq.length ? '$' + median(sq).toFixed(2) : '—';
    } }],
  });

  const rentBins = Charts.histogram(active.map(l=>l.price), 10);
  Charts.columns(document.getElementById('chartRentDist'), {
    title: 'Active asking rent distribution',
    rows: rentBins.map(b=>({ label: fmtMoneyCompact(b.lo), tipTitle: fmtPrice(b.lo) + ' – ' + fmtPrice(b.hi - 1), value: b.count })),
    fmt: v=>v + (v===1 ? ' unit' : ' units'), axisFmt: v=>String(v), labelHead: 'Rent range', valueHead: 'Units',
  });

  const buckets = [['< 1 day', 0, 1], ['1–3 days', 1, 3], ['3–7 days', 3, 7], ['1–2 weeks', 7, 14], ['2–4 weeks', 14, 28], ['1–3 months', 28, 90], ['3+ months', 90, Infinity]];
  Charts.columns(document.getElementById('chartTimeListed'), {
    title: 'How long units stayed listed',
    sub: 'Delisted units, first seen to last seen',
    rows: buckets.map(([name, lo, hi])=>({ label: name, value: delisted.filter(l=>{ const d = listedDays(l); return d >= lo && d < hi; }).length })),
    fmt: v=>v + (v===1 ? ' unit' : ' units'), axisFmt: v=>String(v), labelHead: 'Time listed', valueHead: 'Units',
  });

  const props = [...new Set(all.map(l=>l.property))].filter(Boolean).sort();
  const tbody = document.getElementById('metricsPropertyTable');
  tbody.replaceChildren();
  props.forEach(p=>{
    const a = active.filter(l=>l.property===p), d = delisted.filter(l=>l.property===p);
    const tr = tbody.insertRow();
    [p, String(all.filter(l=>l.property===p).length), String(a.length),
     a.length ? fmtPrice(median(a.map(l=>l.price))) : '—', fmtDays(median(d.map(listedDays)))]
      .forEach(c=>{ tr.insertCell().textContent = c; });
  });
}

loadMetrics();
