// config.js (untracked, see config.example.js) must define:
//   const SUPABASE_URL = "https://xxxx.supabase.co";
//   const SUPABASE_ANON_KEY = "eyJ...";   <- the ANON key only, never service_role
//   const PRICE_THRESHOLD = 2200;
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function fmtPrice(n){ return '$' + Math.round(n).toLocaleString('en-US'); }

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

/* ---------------- Tabs ---------------- */
const TAB_META = {
  'rentals': { title: 'Rental Monitor', sub: 'Live availability across the Stuyvesant Town / Parker Towers / Kips Bay Court / Peter Cooper Village portfolio.' },
  'for-sale': { title: 'For Sale', sub: 'Houses, condos, and co-ops in a handful of Queens/Astoria/Brooklyn neighborhoods.' },
  'savings': { title: 'Savings Calculator', sub: 'Project how a monthly contribution grows toward a goal.' },
  'analytics': { title: 'Building Analytics', sub: 'Preserved (non-lottery) income-restricted housing units across the same Queens/Brooklyn neighborhoods tracked on the For Sale tab.' },
};

function showTab(name){
  if(!TAB_META[name]) name = 'rentals';
  Object.keys(TAB_META).forEach(t=>{
    document.getElementById('tab-' + (t==='for-sale' ? 'forsale' : t)).hidden = (t !== name);
  });
  document.querySelectorAll('.tab-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.tab === name);
  });
  document.getElementById('pageTitle').textContent = TAB_META[name].title;
  document.getElementById('pageSub').textContent = TAB_META[name].sub;
  if(location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
}

document.querySelectorAll('.tab-btn').forEach(b=>{
  b.addEventListener('click', ()=> showTab(b.dataset.tab));
});
window.addEventListener('hashchange', ()=> showTab(location.hash.slice(1)));

/* ---------------- Rentals tab ---------------- */
let rentalListings = [];
const rentalPriceOptions = ['All', `Under $${PRICE_THRESHOLD}`, 'Under $5000', '$5000+'];
let rentalState = { property:'All', priceBand:'All', showDelisted:false };

const CARRIER_GATEWAYS = {
  'AT&T': 'txt.att.net',
  'Verizon': 'vtext.com',
  'T-Mobile': 'tmomail.net',
  'Mint Mobile': 'tmomail.net',
  'Metro by T-Mobile': 'mymetropcs.com',
  'Boost Mobile': 'sms.myboostmobile.com',
  'Cricket Wireless': 'sms.cricketwireless.net',
  'US Cellular': 'email.uscc.net',
  'Google Fi': 'msg.fi.google.com',
  'Visible': 'vtext.com',
  'Xfinity Mobile': 'vtext.com',
};

function populateCarrierOptions(){
  const select = document.getElementById('carrierInput');
  Object.keys(CARRIER_GATEWAYS).forEach(name=>{
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });
}

function normalizePhone(raw){
  let digits = raw.replace(/\D/g, '');
  if(digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits;
}

function showSignupMsg(text, ok){
  const el = document.getElementById('signupMsg');
  el.textContent = text;
  el.className = 'signup-msg ' + (ok ? 'ok' : 'err');
}

// Bedroom count -> threshold input id. "3" covers 3+ bedrooms, matching
// monitor.py's threshold_bed_key (min(bedrooms, 3)).
const THRESHOLD_FIELDS = { '0': 'thresholdStudio', '1': 'threshold1bd', '2': 'threshold2bd', '3': 'threshold3bd' };

// Pre-fill carrier + existing thresholds when a returning number is entered,
// so editing (e.g. changing just the 2BD ceiling) doesn't blank out the
// other bed counts -- the save below overwrites the whole thresholds object.
async function loadExistingSettings(){
  const phone = normalizePhone(document.getElementById('phoneInput').value);
  if(phone.length !== 10) return;
  const { data, error } = await supabaseClient
    .from('subscribers')
    .select('carrier,thresholds')
    .eq('phone_number', phone)
    .maybeSingle();
  if(error || !data) return;
  if(data.carrier) document.getElementById('carrierInput').value = data.carrier;
  Object.entries(THRESHOLD_FIELDS).forEach(([bedKey, inputId])=>{
    const val = (data.thresholds || {})[bedKey];
    document.getElementById(inputId).value = val != null ? val : '';
  });
  showSignupMsg('Loaded your existing settings — edit and save to update.', true);
}

function readThresholds(){
  const thresholds = {};
  Object.entries(THRESHOLD_FIELDS).forEach(([bedKey, inputId])=>{
    const raw = document.getElementById(inputId).value;
    if(raw !== ''){
      const n = Number(raw);
      if(Number.isFinite(n) && n > 0) thresholds[bedKey] = n;
    }
  });
  return thresholds;
}

async function subscribe(){
  const phone = normalizePhone(document.getElementById('phoneInput').value);
  const carrier = document.getElementById('carrierInput').value;
  if(phone.length !== 10){
    showSignupMsg('Enter a valid 10-digit US phone number.', false);
    return;
  }
  if(!carrier){
    showSignupMsg('Select a carrier.', false);
    return;
  }
  const thresholds = readThresholds();
  if(Object.keys(thresholds).length === 0){
    showSignupMsg('Set a max price for at least one bedroom count.', false);
    return;
  }
  const gatewayEmail = phone + '@' + CARRIER_GATEWAYS[carrier];
  const { error } = await supabaseClient
    .from('subscribers')
    .upsert({ phone_number: phone, carrier, gateway_email: gatewayEmail, active: true, thresholds }, { onConflict: 'gateway_email' });
  if(error){
    showSignupMsg('Could not add number: ' + error.message, false);
    return;
  }
  showSignupMsg("You're subscribed — texts start on the next check.", true);
  document.getElementById('phoneInput').value = '';
  document.getElementById('carrierInput').value = '';
  Object.values(THRESHOLD_FIELDS).forEach(id => document.getElementById(id).value = '');
}

async function unsubscribe(){
  const phone = normalizePhone(document.getElementById('unsubPhoneInput').value);
  if(phone.length !== 10){
    showSignupMsg('Enter a valid 10-digit US phone number to remove.', false);
    return;
  }
  const { error } = await supabaseClient
    .from('subscribers')
    .delete()
    .eq('phone_number', phone);
  if(error){
    showSignupMsg('Could not remove number: ' + error.message, false);
    return;
  }
  showSignupMsg('Removed, if it was subscribed.', true);
  document.getElementById('unsubPhoneInput').value = '';
}

async function loadRentalListings(){
  const { data, error } = await supabaseClient
    .from('listings')
    .select('*')
    .order('price', { ascending: true });
  if(error){
    document.getElementById('rentalsLoading').textContent = 'Could not load listings: ' + error.message;
    return;
  }
  rentalListings = data;
  document.getElementById('rentalsLoading').style.display = 'none';
  renderRentals();
}

function timeAgo(iso){
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if(mins < 60) return mins + 'm ago';
  const hours = Math.round(mins / 60);
  if(hours < 24) return hours + 'h ago';
  return Math.round(hours / 24) + 'd ago';
}

function inPriceBand(price){
  if(rentalState.priceBand==='All') return true;
  if(rentalState.priceBand===`Under $${PRICE_THRESHOLD}`) return price < PRICE_THRESHOLD;
  if(rentalState.priceBand==='Under $5000') return price < 5000;
  if(rentalState.priceBand==='$5000+') return price >= 5000;
  return true;
}

function renderRentals(){
  const propertyOptions = ['All', ...new Set(rentalListings.map(l=>l.property))].filter(Boolean);
  buildChips(document.getElementById('propertyRow'), propertyOptions, rentalState, 'property', renderRentals);
  buildChips(document.getElementById('priceRow'), rentalPriceOptions, rentalState, 'priceBand', renderRentals);

  let filtered = rentalListings.filter(l=>{
    if(!rentalState.showDelisted && !l.active) return false;
    if(rentalState.property!=='All' && l.property!==rentalState.property) return false;
    if(!inPriceBand(l.price)) return false;
    return true;
  });

  const list = document.getElementById('rentalsCardList');
  const empty = document.getElementById('rentalsEmpty');
  document.getElementById('rentalsCountLine').textContent = filtered.length + (filtered.length===1 ? ' listing' : ' listings');
  document.getElementById('delistedToggle').textContent = rentalState.showDelisted ? 'Hide delisted' : 'Show delisted';

  if(filtered.length===0){
    list.innerHTML = '';
    empty.style.display = 'block';
    empty.textContent = "Nothing matches that combination right now.";
    return;
  }
  empty.style.display = 'none';

  list.innerHTML = filtered.map(l=>{
    const isDeal = l.price < PRICE_THRESHOLD;
    const factsParts = [];
    if(l.beds != null) factsParts.push(l.beds + ' bd');
    if(l.baths != null) factsParts.push(l.baths + ' ba');
    if(l.sqft) factsParts.push(l.sqft + ' ft²');
    return `
      <div class="card ${isDeal ? 'is-deal' : ''}">
        <div class="card-top">
          <div>
            <p class="place">Unit ${l.unit_number || l.id}${!l.active ? ' (delisted)' : ''}</p>
            <span class="property-tag">${l.property}</span>
          </div>
          <div class="price">${fmtPrice(l.price)}${isDeal ? '<span class="deal-pill">Under threshold</span>' : ''}</div>
        </div>
        <div class="facts">${factsParts.join(' · ')}${l.address ? ' · ' + l.address : ''}</div>
        <div class="card-bottom">
          <span>Available: ${l.available_date || 'n/a'}</span>
          <span>Last seen ${timeAgo(l.last_seen)}</span>
        </div>
      </div>
    `;
  }).join('');
}

// Soft gate on the signup form. The password itself is never sent to the
// client -- check_signup_password() runs server-side (security definer,
// see supabase/app_settings_schema.sql) and only returns true/false.
async function tryUnlockSignup(){
  const entered = document.getElementById('signupPasswordInput').value;
  const btn = document.getElementById('signupUnlockBtn');
  btn.disabled = true;
  const { data, error } = await supabaseClient.rpc('check_signup_password', { input: entered });
  btn.disabled = false;
  if(!error && data === true){
    document.getElementById('signupLocked').style.display = 'none';
    document.getElementById('signupUnlocked').style.display = 'block';
    try{ sessionStorage.setItem('signupUnlocked', '1'); }catch(e){}
  } else {
    const msg = document.getElementById('signupLockMsg');
    msg.textContent = 'Wrong password.';
    msg.className = 'signup-msg err';
  }
}
document.getElementById('signupUnlockBtn').onclick = tryUnlockSignup;
document.getElementById('signupPasswordInput').addEventListener('keydown', e=>{
  if(e.key === 'Enter') tryUnlockSignup();
});
try{
  if(sessionStorage.getItem('signupUnlocked') === '1'){
    document.getElementById('signupLocked').style.display = 'none';
    document.getElementById('signupUnlocked').style.display = 'block';
  }
}catch(e){}

document.getElementById('delistedToggle').onclick = ()=>{ rentalState.showDelisted = !rentalState.showDelisted; renderRentals(); };
document.getElementById('subscribeBtn').onclick = subscribe;
document.getElementById('phoneInput').addEventListener('blur', loadExistingSettings);
document.getElementById('unsubscribeBtn').onclick = unsubscribe;
document.getElementById('unsubscribeToggle').onclick = ()=>{
  const row = document.getElementById('unsubscribeRow');
  row.style.display = row.style.display === 'none' ? 'flex' : 'none';
};

/* ---------------- For Sale tab ---------------- */
let saleListings = [];
let mortgageCalcState = { downPct: 20, rate: 6.71, term: 30 };
let saleFilterState = { type: 'All', city: 'All' };
let priceHistoryByListing = {};

// Address format is "<street>, <city/neighborhood>, NY <zip>" -- the middle
// segment is the Redfin-reported city/neighborhood (e.g. "Bayside",
// "Forest Hills", "Brooklyn", "Long Island City"), which is the closest
// thing to a borough/neighborhood filter without a dedicated column.
function cityOf(address){
  const parts = address.split(',');
  return parts.length >= 2 ? parts[1].trim() : null;
}

function mortgageMath(price){
  const downPct = Math.min(Math.max(mortgageCalcState.downPct, 0), 100);
  const down = price * (downPct/100);
  const loan = price - down;
  const monthlyRate = (mortgageCalcState.rate/100)/12;
  const n = mortgageCalcState.term*12;
  const payment = monthlyRate === 0 ? loan/n :
    loan * (monthlyRate * Math.pow(1+monthlyRate, n)) / (Math.pow(1+monthlyRate, n) - 1);
  return { down, loan, payment };
}

async function loadSaleListings(){
  const { data, error } = await supabaseClient
    .from('housing_listings')
    .select('*')
    .eq('active', true)
    .order('price', { ascending: true });
  if(error){
    document.getElementById('saleLoading').textContent = 'Could not load listings: ' + error.message;
    return;
  }
  saleListings = data;

  const { data: history, error: historyError } = await supabaseClient
    .from('housing_price_history')
    .select('listing_id,sale_date,sale_price')
    .order('sale_date', { ascending: false });
  if(!historyError && history){
    priceHistoryByListing = {};
    history.forEach(h=>{
      if(!priceHistoryByListing[h.listing_id]) priceHistoryByListing[h.listing_id] = [];
      priceHistoryByListing[h.listing_id].push(h);
    });
  }

  document.getElementById('saleLoading').style.display = 'none';
  renderForSale();
}

// Annualized appreciation from the most recent known prior sale to the
// current asking price. Sourced from NYC's public ACRIS deed records (see
// fetch_price_history.py) -- co-ops usually have no entry here, since a
// co-op sale is a share transfer, not a recorded real-property deed.
function appreciationInfo(listing){
  const sales = priceHistoryByListing[listing.id];
  if(!sales || sales.length === 0) return null;
  const last = sales[0];
  const years = (Date.now() - new Date(last.sale_date).getTime()) / (365.25 * 24 * 3600 * 1000);
  if(years < 0.1) return null;
  const rate = (Math.pow(listing.price / last.sale_price, 1/years) - 1) * 100;
  const saleYear = new Date(last.sale_date).getFullYear();
  return { lastPrice: last.sale_price, saleYear, ratePct: rate };
}

function renderForSale(){
  const typeOptions = ['All', ...new Set(saleListings.map(l=>l.property_type).filter(Boolean))];
  buildChips(document.getElementById('typeRow'), typeOptions, saleFilterState, 'type', renderForSale);

  const cityOptions = ['All', ...new Set(saleListings.map(l=>cityOf(l.address)).filter(Boolean))].sort((a,b)=> a==='All' ? -1 : b==='All' ? 1 : a.localeCompare(b));
  buildChips(document.getElementById('cityRow'), cityOptions, saleFilterState, 'city', renderForSale);

  const listings = saleListings.filter(l=>{
    if(saleFilterState.type!=='All' && l.property_type!==saleFilterState.type) return false;
    if(saleFilterState.city!=='All' && cityOf(l.address)!==saleFilterState.city) return false;
    return true;
  });
  document.getElementById('saleCountLine').textContent = listings.length + (listings.length===1 ? ' listing' : ' listings');
  const list = document.getElementById('saleCardList');
  const empty = document.getElementById('saleEmpty');

  if(listings.length===0){
    list.innerHTML = '';
    empty.style.display = 'block';
    empty.textContent = "Nothing found right now.";
    return;
  }
  empty.style.display = 'none';

  list.innerHTML = listings.map(l=>{
    const factsParts = [];
    if(l.beds != null) factsParts.push((l.beds===0 ? 'Studio' : l.beds + ' bd'));
    if(l.baths != null) factsParts.push(l.baths + ' ba');
    if(l.sqft) factsParts.push(l.sqft + ' ft²');
    const m = mortgageMath(l.price);
    const appr = appreciationInfo(l);
    return `
      <div class="card">
        <div class="card-top">
          <div>
            <p class="place">${l.address}</p>
            ${l.property_type ? `<span class="type-tag">${l.property_type}</span>` : ''}
          </div>
          <div class="price">${fmtPrice(l.price)}</div>
        </div>
        <div class="facts">${factsParts.join(' · ')}</div>
        ${appr ? `<div class="facts">Last sold ${fmtPrice(appr.lastPrice)} (${appr.saleYear}) · ${appr.ratePct >= 0 ? '+' : ''}${appr.ratePct.toFixed(1)}%/yr since</div>` : ''}
        <div class="mortgage-box">
          <div class="m-item"><div class="m-label">Down (${mortgageCalcState.downPct}%)</div><div class="m-value">${fmtPrice(m.down)}</div></div>
          <div class="m-item"><div class="m-label">Loan amount</div><div class="m-value">${fmtPrice(m.loan)}</div></div>
          <div class="m-item"><div class="m-label">Est. P&amp;I / mo</div><div class="m-value">${fmtPrice(m.payment)}</div></div>
        </div>
        <div class="card-bottom">
          <span></span>
          <a class="view-link" href="${l.source_url}" target="_blank">View on Redfin</a>
        </div>
      </div>
    `;
  }).join('');
}

document.getElementById('downPct').addEventListener('input', e=>{ mortgageCalcState.downPct = parseFloat(e.target.value)||0; renderForSale(); });
document.getElementById('rate').addEventListener('input', e=>{ mortgageCalcState.rate = parseFloat(e.target.value)||0; renderForSale(); });
document.querySelectorAll('.term-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.term-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    mortgageCalcState.term = parseInt(btn.dataset.term, 10);
    mortgageCalcState.rate = parseFloat(btn.dataset.rate);
    document.getElementById('rate').value = mortgageCalcState.rate;
    renderForSale();
  });
});

/* ---------------- Savings Calculator tab ---------------- */
// Everything here is computed client-side from the four inputs on demand --
// nothing is persisted (no DB table, no localStorage), matching the ask
// that this tab hold no state of its own.
function projectSavings(start, monthly, annualRatePct, goal){
  const r = (annualRatePct/100)/12;
  let balance = start;
  const yearly = [{ year: 0, balance }];
  const maxMonths = 50*12;
  for(let m=1; m<=maxMonths; m++){
    balance = balance*(1+r) + monthly;
    if(m % 12 === 0) yearly.push({ year: m/12, balance });
    if(goal > 0 && balance >= goal){
      return { reached:true, months:m, yearly, finalBalance:balance };
    }
  }
  return { reached:false, months:maxMonths, yearly, finalBalance:balance };
}

function renderSavings(){
  const start = parseFloat(document.getElementById('savStart').value) || 0;
  const monthly = parseFloat(document.getElementById('savMonthly').value) || 0;
  const rate = parseFloat(document.getElementById('savRate').value) || 0;
  const goal = parseFloat(document.getElementById('savGoal').value) || 0;

  const result = document.getElementById('savingsResult');

  if(goal <= start){
    result.innerHTML = `<div class="savings-result"><p class="savings-headline">You're already there</p><p class="savings-sub">Current savings already meet or exceed the goal.</p></div>`;
    return;
  }
  if(monthly <= 0 && rate <= 0){
    result.innerHTML = `<div class="savings-result"><p class="savings-headline">Add a monthly contribution or return rate</p><p class="savings-sub">With $0/mo and 0% growth the balance never moves.</p></div>`;
    return;
  }

  const proj = projectSavings(start, monthly, rate, goal);
  const years = Math.floor(proj.months / 12);
  const months = proj.months % 12;
  const whenParts = [];
  if(years) whenParts.push(years + (years===1 ? ' year' : ' years'));
  if(months) whenParts.push(months + (months===1 ? ' month' : ' months'));
  const targetDate = new Date();
  targetDate.setMonth(targetDate.getMonth() + proj.months);
  const dateStr = targetDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const headline = proj.reached
    ? `Reach ${fmtPrice(goal)} in ${whenParts.join(', ')}`
    : `Still short of ${fmtPrice(goal)} after 50 years`;
  const sub = proj.reached
    ? `Around ${dateStr}, assuming a steady ${fmtPrice(monthly)}/mo and ${rate}%/yr.`
    : `Projected balance after 50 years: ${fmtPrice(proj.finalBalance)}. Try a higher monthly contribution or return rate.`;

  const rows = proj.yearly.map(y => `<tr><td>Year ${y.year}</td><td>${fmtPrice(y.balance)}</td></tr>`).join('');

  result.innerHTML = `
    <div class="savings-result">
      <p class="savings-headline">${headline}</p>
      <p class="savings-sub">${sub}</p>
      <div class="savings-table-wrap">
        <table class="savings-table">
          <thead><tr><th>Year</th><th>Balance</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

['savStart','savMonthly','savRate','savGoal'].forEach(id=>{
  document.getElementById(id).addEventListener('input', renderSavings);
});

/* ---------------- Analytics tab: income-restricted housing (Low/Moderate Income only) ---------------- */
// Static data (see analyze_affordable_housing.py) -- no DB, no live queries.
function fmtNum(n){ return n.toLocaleString('en-US'); }

let affordData = { tiers: [], neighborhoods: [], buildings: [] };
let affordFilterState = { neighborhood: 'All', tier: 'All' };

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
      ${affordData.tiers.map(t=>`
        <div class="stat-card"><div class="stat-value">${fmtNum(byTier[t.label]||0)}</div><div class="stat-label">${t.label} units (${t.ami_range})</div></div>
      `).join('')}
    </div>
    <table class="neighborhood-table">
      <thead><tr><th>Neighborhood</th><th>Buildings</th>${affordData.tiers.map(t=>`<th>${t.label}</th>`).join('')}</tr></thead>
      <tbody>
        ${affordData.neighborhoods
          .slice()
          .sort((a,b)=> b.buildings - a.buildings)
          .map(n=>`<tr><td>${n.neighborhood}</td><td>${n.buildings}</td>${affordData.tiers.map(t=>`<td>${fmtNum(n.units_by_tier[t.label]||0)}</td>`).join('')}</tr>`)
          .join('')}
      </tbody>
    </table>
  `;
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
    const tierTags = Object.entries(b.units_by_tier).map(([label,n])=>`<span class="type-tag">${n} ${label}</span>`).join(' ');
    const addrHtml = b.portal_url
      ? `<a class="view-link" href="${b.portal_url}" target="_blank" rel="noopener">${b.address}</a>`
      : b.address;
    // No website field in HPD's dataset -- best-effort fallback so you can
    // still find a management/leasing page if one exists.
    const searchQuery = encodeURIComponent(`${b.address} ${b.neighborhood} NYC apartments`);
    const searchUrl = `https://www.google.com/search?q=${searchQuery}`;
    return `
      <div class="complex-card">
        <div class="card-top">
          <div>
            <p class="place">${b.total_income_restricted_units} units</p>
            ${tierTags}
          </div>
        </div>
        <div class="facts">${b.neighborhood}${b.total_units ? ' · ' + b.total_units + ' total units in building' : ''}</div>
        <div class="complex-addr">${addrHtml} · <a class="view-link" href="${searchUrl}" target="_blank" rel="noopener">search for a website</a></div>
      </div>
    `;
  }).join('');
}

function loadAffordableHousing(){
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

/* ---------------- Init ---------------- */
populateCarrierOptions();
loadRentalListings();
loadSaleListings();
renderSavings();
loadAffordableHousing();
showTab(location.hash.slice(1) || 'rentals');
