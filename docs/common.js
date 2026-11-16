// Shared helpers for every page. config.js (committed -- it only holds the
// public anon key; see config.example.js) must be loaded first and define:
//   const SUPABASE_URL = "https://xxxx.supabase.co";
//   const SUPABASE_ANON_KEY = "eyJ...";   <- the ANON key only, never service_role
//   const PRICE_THRESHOLD = 2200;
// Pages that don't talk to Supabase skip loading supabase-js, so the client
// is only created when the library is present.
const supabaseClient = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

function fmtPrice(n){ return '$' + Math.round(n).toLocaleString('en-US'); }
function fmtNum(n){ return n.toLocaleString('en-US'); }

// $850K / $1.2M -- for chart axes and bin labels where full figures crowd.
function fmtMoneyCompact(n){
  const a = Math.abs(n);
  if(a >= 1e6) return '$' + (n/1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M';
  if(a >= 1e4) return '$' + Math.round(n/1e3) + 'K';
  return fmtPrice(n);
}

// Escape for interpolation into HTML strings. Listing fields come from
// third-party sites via the monitor (and HPD data), so treat every one as
// untrusted text, never markup.
function esc(v){
  return String(v == null ? '' : v).replace(/[&<>"']/g, ch=>({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}

// Only http(s) links reach an href; anything else (javascript:, data:, ...)
// becomes '#'. Returned already escaped for an attribute.
function safeUrl(u){
  try{
    const url = new URL(String(u), location.href);
    return (url.protocol === 'https:' || url.protocol === 'http:') ? esc(url.href) : '#';
  }catch(e){ return '#'; }
}

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

// Calendar day (America/New_York) as YYYY-MM-DD, so "today" matches the
// 6-10am ET monitoring window regardless of the viewer's timezone.
function etDay(d){
  return new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// "2026-11-03" -> "Nov 3"
function shortDay(isoDay){
  return new Date(isoDay + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function median(nums){
  if(!nums.length) return null;
  const a = nums.slice().sort((x,y)=>x-y), m = Math.floor(a.length/2);
  return a.length % 2 ? a[m] : (a[m-1] + a[m]) / 2;
}

function fmtDays(d){
  if(d==null) return '—';
  return d < 1 ? Math.round(d*24) + 'h' : (Math.round(d*10)/10) + 'd';
}

function timeAgo(iso){
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if(mins < 60) return mins + 'm ago';
  const hours = Math.round(mins / 60);
  if(hours < 24) return hours + 'h ago';
  return Math.round(hours / 24) + 'd ago';
}
