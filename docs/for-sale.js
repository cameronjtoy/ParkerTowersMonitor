// For Sale page (for-sale.html). Helpers are in common.js, charts in charts.js.

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
  renderSaleCharts(listings);
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
    if(l.beds != null) factsParts.push((l.beds===0 ? 'Studio' : esc(l.beds) + ' bd'));
    if(l.baths != null) factsParts.push(esc(l.baths) + ' ba');
    if(l.sqft) factsParts.push(esc(l.sqft) + ' ft²');
    const m = mortgageMath(l.price);
    const appr = appreciationInfo(l);
    return `
      <div class="card">
        <div class="card-top">
          <div>
            <p class="place">${esc(l.address)}</p>
            ${l.property_type ? `<span class="type-tag">${esc(l.property_type)}</span>` : ''}
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
          <a class="view-link" href="${safeUrl(l.source_url)}" target="_blank" rel="noopener noreferrer">View on Redfin</a>
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

// Charts follow the type/city chips, so every number on the page agrees.
// A chart is skipped when it would be a single bar (the number says it all).
function renderSaleCharts(listings){
  const priceEl = document.getElementById('salePriceChart');
  const cityEl = document.getElementById('saleCityChart');
  const typeEl = document.getElementById('saleTypeChart');
  [priceEl, cityEl, typeEl].forEach(el=>{ el.hidden = true; });
  if(listings.length < 2) return;

  const bins = Charts.histogram(listings.map(l=>l.price), 8);
  priceEl.hidden = false;
  Charts.columns(priceEl, {
    title: 'Asking price distribution',
    sub: listings.length + ' listings, grouped by asking price',
    rows: bins.map(b=>({ label: fmtMoneyCompact(b.lo), tipTitle: fmtMoneyCompact(b.lo) + ' – ' + fmtMoneyCompact(b.hi), value: b.count })),
    fmt: v=>v + (v===1 ? ' listing' : ' listings'), axisFmt: v=>String(v),
    labelHead: 'Price range', valueHead: 'Listings',
  });

  const medianBy = keyFn=>{
    const groups = {};
    listings.forEach(l=>{ const k = keyFn(l); if(k) (groups[k] = groups[k] || []).push(l.price); });
    return Object.entries(groups)
      .map(([k, ps])=>({ label: k, value: median(ps), tipTitle: `${k} · ${ps.length} ${ps.length===1 ? 'listing' : 'listings'}` }))
      .sort((a,b)=>b.value - a.value);
  };
  const byCity = medianBy(l=>cityOf(l.address));
  if(byCity.length >= 2){
    cityEl.hidden = false;
    Charts.bars(cityEl, { title: 'Median asking price by neighborhood', rows: byCity, fmt: fmtMoneyCompact, labelHead: 'Neighborhood', valueHead: 'Median price' });
  }
  const byType = medianBy(l=>l.property_type);
  if(byType.length >= 2){
    typeEl.hidden = false;
    Charts.bars(typeEl, { title: 'Median asking price by property type', rows: byType, fmt: fmtMoneyCompact, labelHead: 'Type', valueHead: 'Median price' });
  }
}

loadSaleListings();
