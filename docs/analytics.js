function fmtNum(n){ return n.toLocaleString('en-US'); }

function buildChips(row, options, stateObj, key, onChange){
  row.innerHTML = '';
  options.forEach(opt=>{
    const chip = document.createElement('div');
    chip.className = 'chip' + (stateObj[key]===opt ? ' active' : '');
    chip.textContent = opt;
    chip.onclick = ()=>{ stateObj[key] = opt; onChange(); };
    row.appendChild(chip);
  });
}

let hpdData = { neighborhoods: [], complexes: [] };
let filterState = { neighborhood: 'All' };

function renderDashboard(){
  const totalBuildings = hpdData.neighborhoods.reduce((s,n)=>s+n.buildings, 0);
  const totalComplexes = hpdData.complexes.length;
  const programTotals = {};
  hpdData.neighborhoods.forEach(n=>{
    Object.entries(n.management_programs).forEach(([prog, count])=>{
      programTotals[prog] = (programTotals[prog] || 0) + count;
    });
  });
  const subsidized = Object.entries(programTotals)
    .filter(([prog])=> prog !== 'PVT')
    .reduce((s,[,c])=>s+c, 0);

  const dash = document.getElementById('dashSection');
  dash.innerHTML = `
    <div class="dash-grid">
      <div class="stat-card"><div class="stat-value">${fmtNum(totalBuildings)}</div><div class="stat-label">Registered buildings tracked</div></div>
      <div class="stat-card"><div class="stat-value">${fmtNum(totalComplexes)}</div><div class="stat-label">Multi-building complexes</div></div>
      <div class="stat-card"><div class="stat-value">${fmtNum(subsidized)}</div><div class="stat-label">Buildings under a non-private program (NYCHA, Mitchell-Lama, etc.)</div></div>
      <div class="stat-card"><div class="stat-value">${fmtNum(hpdData.neighborhoods.length)}</div><div class="stat-label">Neighborhoods covered</div></div>
    </div>
    <table class="neighborhood-table">
      <thead><tr><th>Neighborhood</th><th>Buildings</th><th>Complexes</th><th>Non-private</th></tr></thead>
      <tbody>
        ${hpdData.neighborhoods
          .slice()
          .sort((a,b)=> b.buildings - a.buildings)
          .map(n=>{
            const nonPvt = Object.entries(n.management_programs).filter(([p])=>p!=='PVT').reduce((s,[,c])=>s+c,0);
            return `<tr><td>${n.neighborhood}</td><td>${fmtNum(n.buildings)}</td><td>${n.complexes}</td><td>${fmtNum(nonPvt)}</td></tr>`;
          }).join('')}
      </tbody>
    </table>
  `;
}

function renderComplexes(){
  const neighborhoodOptions = ['All', ...new Set(hpdData.complexes.map(c=>c.neighborhood))].sort((a,b)=> a==='All' ? -1 : b==='All' ? 1 : a.localeCompare(b));
  buildChips(document.getElementById('neighborhoodRow'), neighborhoodOptions, filterState, 'neighborhood', renderComplexes);

  const filtered = hpdData.complexes.filter(c=>{
    if(filterState.neighborhood!=='All' && c.neighborhood!==filterState.neighborhood) return false;
    return true;
  });

  document.getElementById('complexCountLine').textContent = filtered.length + (filtered.length===1 ? ' complex' : ' complexes');

  const grid = document.getElementById('complexGrid');
  const empty = document.getElementById('complexEmpty');
  if(filtered.length===0){
    grid.innerHTML = '';
    empty.style.display = 'block';
    empty.textContent = 'No multi-building complexes found for that neighborhood in this data.';
    return;
  }
  empty.style.display = 'none';

  grid.innerHTML = filtered.map(c=>{
    const isNycha = c.management_program === 'NYCHA';
    const addrList = c.addresses.join(', ') + (c.addresses_truncated ? ', …' : '');
    return `
      <div class="complex-card">
        <div class="card-top">
          <div>
            <p class="place">${c.building_count} buildings</p>
            <span class="type-tag ${isNycha ? 'badge-nycha' : ''}">${c.management_program}</span>
          </div>
        </div>
        <div class="facts">${c.neighborhood}${c.avg_stories ? ' · avg ' + c.avg_stories + ' stories' : ''}</div>
        <div class="complex-addr">${addrList}</div>
      </div>
    `;
  }).join('');
}

fetch('hpd_complexes.json')
  .then(r=>r.json())
  .then(data=>{
    hpdData = data;
    document.getElementById('loading').style.display = 'none';
    renderDashboard();
    renderComplexes();
  })
  .catch(err=>{
    document.getElementById('loading').textContent = 'Could not load building data: ' + err.message;
  });
