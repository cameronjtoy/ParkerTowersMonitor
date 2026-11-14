// Pre-split links used index.html#<tab>; send them to the page that replaced
// the tab. A separate file (not inline) so the pages' CSP can forbid inline script.
(function(){
  var moved = { 'for-sale': 'for-sale.html', 'savings': 'savings.html', 'analytics': 'analytics.html', 'metrics': 'metrics.html' };
  var to = moved[location.hash.slice(1)];
  if(to) location.replace(to);
})();
