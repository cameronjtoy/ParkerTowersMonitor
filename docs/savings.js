// Savings page (savings.html).
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
  const chartEl = document.getElementById('savingsChart');
  chartEl.hidden = true;

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

  result.innerHTML = `<div class="savings-result"><p class="savings-headline"></p><p class="savings-sub"></p></div>`;
  result.querySelector('.savings-headline').textContent = headline;
  result.querySelector('.savings-sub').textContent = sub;
  chartEl.hidden = false;

  // Balance vs. what was actually put in -- the gap between the lines is growth.
  // The table view (chart's Table toggle) replaces the old year-by-year table.
  const contributed = proj.yearly.map(y=> start + monthly*12*y.year);
  Charts.line(chartEl, {
    title: 'Projected balance by year',
    sub: 'Balance with returns vs. total contributed',
    labels: proj.yearly.map(y=>'Year ' + y.year),
    series: [
      { name: 'Balance', values: proj.yearly.map(y=>y.balance), color: Charts.SERIES[0] },
      { name: 'Contributed', values: contributed, color: Charts.SERIES[1] },
    ],
    fmt: fmtPrice, axisFmt: fmtMoneyCompact, labelHead: 'Year',
    refLine: goal > 0 ? { value: goal, label: 'Goal ' + fmtPrice(goal) } : null,
  });
}


['savStart','savMonthly','savRate','savGoal'].forEach(id=>{
  document.getElementById(id).addEventListener('input', renderSavings);
});

renderSavings();
