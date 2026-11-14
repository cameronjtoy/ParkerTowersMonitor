// Analytics page (analytics.html): income-restricted housing (Low/Moderate Income only).
// Static data (see analyze_affordable_housing.py) -- no DB, no live queries.

let affordData = { tiers: [], neighborhoods: [], buildings: [] };
let affordFilterState = { neighborhood: 'All', tier: 'All' };

// Official 2026 HPD Area Median Income chart (nyc.gov/site/hpd/services-and-
// information/area-median-income.page) -- the $ cutoff at each household
// size for 30/50/80/120/165% AMI. 100% AMI base: $152,700 for a 3-person
// household. Updated annually by HPD; household sizes above 5 are on the
// same page if this ever needs extending.
const AMI_CHART_2026 = [
  { size: 1, ami30: 35640, ami50: 59400, ami80: 95040, ami120: 142560, ami165: 196020 },
  { size: 2, ami30: 40710, ami50: 67850, ami80: 108560, ami120: 162840, ami165: 223905 },
  { size: 3, ami30: 45810, ami50: 76350, ami80: 122160, ami120: 183240, ami165: 251955 },
  { size: 4, ami30: 50880, ami50: 84800, ami80: 135680, ami120: 203520, ami165: 279840 },
  { size: 5, ami30: 54960, ami50: 91600, ami80: 146560, ami120: 219840, ami165: 302280 },
];

function renderAmiChart(){
  const section = document.getElementById('amiChartSection');
  section.innerHTML = `
    <p class="calc-note" style="margin-top:0;">Annual household income ranges by household size, per HPD's official 2026 AMI chart. A tier's units are reserved for households earning within that range.</p>
    <div style="overflow-x:auto;">
      <table class="neighborhood-table">
        <thead>
          <tr>
            <th>Household size</th>
            <th>Extremely Low<br>(0-30% AMI)</th>
            <th>Very Low<br>(31-50% AMI)</th>
            <th>Low<br>(51-80% AMI)</th>
            <th>Moderate<br>(81-120% AMI)</th>
            <th>Middle<br>(121-165% AMI)</th>
          </tr>
        </thead>
        <tbody>
          ${AMI_CHART_2026.map(r => `
            <tr>
              <td>${r.size}</td>
              <td>$0 – ${fmtNum(r.ami30)}</td>
              <td>${fmtNum(r.ami30+1)} – ${fmtNum(r.ami50)}</td>
              <td>${fmtNum(r.ami50+1)} – ${fmtNum(r.ami80)}</td>
              <td>${fmtNum(r.ami80+1)} – ${fmtNum(r.ami120)}</td>
              <td>${fmtNum(r.ami120+1)} – ${fmtNum(r.ami165)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderAffordDashboard(){
  const totalUnits = affordData.buildings.reduce((s,b)=>s+b.total_income_restricted_units, 0);
  const totalBuildings = affordData.buildings.length;
  const byTier = {};
  affordData.tiers.forEach(t => byTier[t.label] = 0);
  affordData.buildings.forEach(b=>{
    Object.entries(b.units_by_tier).forEach(([label, n])=>{ byTier[label] = (byTier[label]||0) + n; });
  });

  const dash = document.getElementById('affordDashSection');
  dash.innerHTML = `
    <div class="dash-grid">
      <div class="stat-card"><div class="stat-value">${fmtNum(totalUnits)}</div><div class="stat-label">Income-restricted units (all tiers)</div></div>
      <div class="stat-card"><div class="stat-value">${fmtNum(totalBuildings)}</div><div class="stat-label">Buildings with such units</div></div>
    </div>
    <div id="affordTierChart"></div>
    <div id="affordNeighborhoodChart"></div>
    <div id="affordTopChart"></div>
  `;

  // Tiers are ordered (lowest income first), so they take the ordinal ramp,
  // and the same tier keeps the same color in every chart on the page.
  const tierColor = {};
  affordData.tiers.forEach((t, i)=>{ tierColor[t.label] = Charts.TIER_RAMP[i % Charts.TIER_RAMP.length]; });

  Charts.bars(document.getElementById('affordTierChart'), {
    title: 'Units by income tier',
    rows: affordData.tiers.map(t=>({ label: t.label, tipTitle: `${t.label} (${t.ami_range})`, value: byTier[t.label]||0, color: tierColor[t.label] })),
    fmt: fmtNum, labelHead: 'Tier', valueHead: 'Units',
  });

  // neighborhoods.json is per ZIP, so the same name can appear more than once.
  const hoods = {};
  affordData.neighborhoods.forEach(n=>{
    const h = hoods[n.neighborhood] = hoods[n.neighborhood] || { label: n.neighborhood, buildings: 0, byTier: {} };
    h.buildings += n.buildings;
    Object.entries(n.units_by_tier).forEach(([label, u])=>{ h.byTier[label] = (h.byTier[label]||0) + u; });
  });
  const hoodRows = Object.values(hoods)
    .map(h=>({ label: h.label, extra: h.buildings, values: affordData.tiers.map(t=>h.byTier[t.label]||0) }))
    .sort((a,b)=> b.values.reduce((s,v)=>s+v,0) - a.values.reduce((s,v)=>s+v,0));
  Charts.stackedBars(document.getElementById('affordNeighborhoodChart'), {
    title: 'Units by neighborhood and tier',
    sub: 'Income-restricted units per neighborhood, split by tier',
    series: affordData.tiers.map(t=>({ name: t.label, color: tierColor[t.label] })),
    rows: hoodRows, fmt: fmtNum, labelHead: 'Neighborhood', extraHead: 'Buildings',
  });

  const top = affordData.buildings.slice()
    .sort((a,b)=>b.total_income_restricted_units - a.total_income_restricted_units)
    .slice(0, 10);
  Charts.bars(document.getElementById('affordTopChart'), {
    title: 'Largest buildings',
    sub: 'Top 10 by income-restricted units',
    rows: top.map(b=>({ label: b.address, tipTitle: `${b.address} · ${b.neighborhood}`, value: b.total_income_restricted_units })),
    fmt: fmtNum, labelHead: 'Building', valueHead: 'Units',
  });
}

function renderAffordBuildings(){
  const tierOptions = ['All', ...affordData.tiers.map(t=>t.label)];
  buildChips(document.getElementById('tierRow'), tierOptions, affordFilterState, 'tier', renderAffordBuildings);

  const neighborhoodOptions = ['All', ...new Set(affordData.buildings.map(b=>b.neighborhood))].sort((a,b)=> a==='All' ? -1 : b==='All' ? 1 : a.localeCompare(b));
  buildChips(document.getElementById('affordNeighborhoodRow'), neighborhoodOptions, affordFilterState, 'neighborhood', renderAffordBuildings);

  const filtered = affordData.buildings.filter(b=>{
    if(affordFilterState.neighborhood!=='All' && b.neighborhood!==affordFilterState.neighborhood) return false;
    if(affordFilterState.tier!=='All' && !(b.units_by_tier[affordFilterState.tier] > 0)) return false;
    return true;
  });

  document.getElementById('affordCountLine').textContent = filtered.length + (filtered.length===1 ? ' building' : ' buildings');

  const grid = document.getElementById('affordGrid');
  const empty = document.getElementById('affordEmpty');
  if(filtered.length===0){
    grid.innerHTML = '';
    empty.style.display = 'block';
    empty.textContent = 'No income-restricted units found for that filter combination in this data.';
    return;
  }
  empty.style.display = 'none';

  grid.innerHTML = filtered.map(b=>{
    const tierTags = Object.entries(b.units_by_tier).map(([label,n])=>`<span class="type-tag">${esc(n)} ${esc(label)}</span>`).join(' ');
    const addrHtml = b.portal_url
      ? `<a class="view-link" href="${safeUrl(b.portal_url)}" target="_blank" rel="noopener noreferrer">${esc(b.address)}</a>`
      : esc(b.address);
    // No website field in HPD's dataset -- best-effort fallback so you can
    // still find a management/leasing page if one exists.
    const searchQuery = encodeURIComponent(`${b.address} ${b.neighborhood} NYC apartments`);
    const searchUrl = `https://www.google.com/search?q=${searchQuery}`;
    return `
      <div class="complex-card">
        <div class="card-top">
          <div>
            <p class="place">${esc(b.total_income_restricted_units)} units</p>
            ${tierTags}
          </div>
        </div>
        <div class="facts">${esc(b.neighborhood)}${b.total_units ? ' · ' + esc(b.total_units) + ' total units in building' : ''}</div>
        <div class="complex-addr">${addrHtml} · <a class="view-link" href="${esc(searchUrl)}" target="_blank" rel="noopener noreferrer">search for a website</a></div>
      </div>
    `;
  }).join('');
}

function loadAffordableHousing(){
  renderAmiChart();
  fetch('affordable_housing.json')
    .then(r=>r.json())
    .then(data=>{
      affordData = data;
      document.getElementById('affordLoading').style.display = 'none';
      renderAffordDashboard();
      renderAffordBuildings();
    })
    .catch(err=>{
      document.getElementById('affordLoading').textContent = 'Could not load affordable housing data: ' + err.message;
    });
}

loadAffordableHousing();
