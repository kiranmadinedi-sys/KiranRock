(async ()=>{
  try{
    const svc = require('./src/services/tradesDatabaseService');
    const rows = await svc.getFirstBuyDates('83f08677-e55a-48d1-bd31-f5b56fa79c23');
    console.log(JSON.stringify(rows,null,2));
  }catch(e){
    console.error('ERR', e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();
