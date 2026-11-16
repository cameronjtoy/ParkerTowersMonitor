// Rentals page (index.html): live listings, today's summary, text signup and
// building suggestions. Helpers (supabaseClient, fmtPrice, etDay, ...) are in common.js.

let rentalListings = [];
const rentalPriceOptions = ['All', `Under $${PRICE_THRESHOLD}`, 'Under $5000', '$5000+'];
let rentalState = { property:'All', priceBand:'All', showDelisted:false };

// Carrier names for the dropdown. The gateway domain is derived server-side by
// carrier_gateway_domain() in supabase/subscribers_lockdown.sql -- keep both in sync.
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

// The signup password is checked server-side on every subscriber call (see
// supabase/subscribers_lockdown.sql), so it's kept for this tab's session
// once it has unlocked the form. The table itself is not readable or writable
// with the anon key.
let signupPassword = null;
try{ signupPassword = sessionStorage.getItem('signupPassword'); }catch(e){}

function lockSignup(message){
  signupPassword = null;
  try{ sessionStorage.removeItem('signupPassword'); }catch(e){}
  document.getElementById('signupUnlocked').style.display = 'none';
  document.getElementById('signupLocked').style.display = 'block';
  const msg = document.getElementById('signupLockMsg');
  msg.textContent = message || '';
  msg.className = 'signup-msg err';
}

// Calls one of the subscriber RPCs. Returns the JSON result, or null after
// showing the error (and re-locking the form if the password stopped working).
async function subscriberRpc(fn, args){
  const { data, error } = await supabaseClient.rpc(fn, Object.assign({ p_password: signupPassword }, args));
  if(error){
    showSignupMsg('Could not save: ' + error.message, false);
    return null;
  }
  if(data && data.status === 'invalid_password'){
    lockSignup('The password has changed — enter it again.');
    return null;
  }
  return data;
}

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
  const data = await subscriberRpc('get_subscriber_settings', { p_phone: phone });
  if(!data || !data.found) return;
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
  // The gateway address is derived server-side from the carrier name.
  const data = await subscriberRpc('subscribe_number', { p_phone: phone, p_carrier: carrier, p_thresholds: thresholds });
  if(!data) return;
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
  const data = await subscriberRpc('unsubscribe_number', { p_phone: phone });
  if(!data) return;
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
  renderTodaySummary();
  renderRentals();
}

function renderTodaySummary(){
  const box = document.getElementById('todaySummary');
  const today = etDay(Date.now());
  const fresh = rentalListings.filter(l=> etDay(l.first_seen) === today);
  box.style.display = 'block';
  if(fresh.length===0){
    box.innerHTML = `<p class="signup-title">New today</p><p class="signup-sub" style="margin:0;">No new listings so far today.</p>`;
    return;
  }
  const prices = fresh.map(l=>l.price);
  const byProp = {};
  fresh.forEach(l=>{ (byProp[l.property] = byProp[l.property] || []).push(l); });
  const bedLabel = b => b==null ? '?' : (b===0 ? 'Studio' : b + 'BD');
  const rows = Object.keys(byProp).sort().map(prop=>{
    const items = byProp[prop].slice().sort((a,b)=>a.price-b.price);
    const lines = items.map(l=>
      `<div class="sum-unit"><span>${esc(bedLabel(l.beds))} · Unit ${esc(l.unit_number || l.id)}${l.sqft ? ' · ' + esc(l.sqft) + ' ft²' : ''}</span><span>${fmtPrice(l.price)}</span></div>`
    ).join('');
    return `<div class="sum-prop"><span class="property-tag">${esc(prop)}</span> <strong>${items.length}</strong> new</div>${lines}`;
  }).join('');
  box.innerHTML = `
    <p class="signup-title">New today</p>
    <p class="signup-sub">${fresh.length} new ${fresh.length===1 ? 'listing' : 'listings'} · ${fmtPrice(Math.min(...prices))}–${fmtPrice(Math.max(...prices))}</p>
    ${rows}`;
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
    if(l.beds != null) factsParts.push(esc(l.beds) + ' bd');
    if(l.baths != null) factsParts.push(esc(l.baths) + ' ba');
    if(l.sqft) factsParts.push(esc(l.sqft) + ' ft²');
    return `
      <div class="card ${isDeal ? 'is-deal' : ''}">
        <div class="card-top">
          <div>
            <p class="place">Unit ${esc(l.unit_number || l.id)}${!l.active ? ' (delisted)' : ''}</p>
            <span class="property-tag">${esc(l.property)}</span>
          </div>
          <div class="price">${fmtPrice(l.price)}${isDeal ? '<span class="deal-pill">Under threshold</span>' : ''}</div>
        </div>
        <div class="facts">${factsParts.join(' · ')}${l.address ? ' · ' + esc(l.address) : ''}</div>
        <div class="card-bottom">
          <span>Available: ${esc(l.available_date || 'n/a')}</span>
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
  const msg = document.getElementById('signupLockMsg');
  if(!error && data === true){
    signupPassword = entered;
    try{ sessionStorage.setItem('signupPassword', entered); }catch(e){}
    document.getElementById('signupPasswordInput').value = '';
    msg.textContent = '';
    document.getElementById('signupLocked').style.display = 'none';
    document.getElementById('signupUnlocked').style.display = 'block';
  } else {
    msg.textContent = error ? 'Could not check password: ' + error.message : 'Wrong password.';
    msg.className = 'signup-msg err';
  }
}
document.getElementById('signupUnlockBtn').onclick = tryUnlockSignup;
document.getElementById('signupPasswordInput').addEventListener('keydown', e=>{
  if(e.key === 'Enter') tryUnlockSignup();
});
if(signupPassword){
  document.getElementById('signupLocked').style.display = 'none';
  document.getElementById('signupUnlocked').style.display = 'block';
}
try{ sessionStorage.removeItem('signupUnlocked'); }catch(e){}  // pre-lockdown flag, no longer used

document.getElementById('delistedToggle').onclick = ()=>{ rentalState.showDelisted = !rentalState.showDelisted; renderRentals(); };
document.getElementById('subscribeBtn').onclick = subscribe;
document.getElementById('phoneInput').addEventListener('blur', loadExistingSettings);
document.getElementById('unsubscribeBtn').onclick = unsubscribe;
document.getElementById('unsubscribeToggle').onclick = ()=>{
  const row = document.getElementById('unsubscribeRow');
  row.style.display = row.style.display === 'none' ? 'flex' : 'none';
};

// Write-only from here -- the anon key can insert a suggestion but has no
// select policy on building_suggestions, so submissions aren't readable
// back through the site (see supabase/building_suggestions_schema.sql).
async function submitSuggestion(){
  const suggestion = document.getElementById('suggestionInput').value.trim();
  const contact = document.getElementById('suggestionContactInput').value.trim();
  const msgEl = document.getElementById('suggestMsg');
  if(!suggestion){
    msgEl.textContent = 'Enter a building name or address.';
    msgEl.className = 'signup-msg err';
    return;
  }
  const { error } = await supabaseClient
    .from('building_suggestions')
    .insert({ suggestion, contact: contact || null });
  if(error){
    msgEl.textContent = 'Could not submit: ' + error.message;
    msgEl.className = 'signup-msg err';
    return;
  }
  msgEl.textContent = 'Thanks — got it.';
  msgEl.className = 'signup-msg ok';
  document.getElementById('suggestionInput').value = '';
  document.getElementById('suggestionContactInput').value = '';
}
document.getElementById('suggestBtn').onclick = submitSuggestion;

populateCarrierOptions();
loadRentalListings();
