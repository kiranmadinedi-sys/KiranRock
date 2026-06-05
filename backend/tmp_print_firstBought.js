(async ()=>{
  try{
    const svc = require('./src/services/portfolioTrackingService');
    const p = await svc.getPortfolioSummary('83f08677-e55a-48d1-bd31-f5b56fa79c23');
    console.log(JSON.stringify((p.holdings||[]).map(h=>({symbol:h.symbol,firstBought:h.firstBought})),null,2));
  }catch(e){
    console.error('ERR', e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();
