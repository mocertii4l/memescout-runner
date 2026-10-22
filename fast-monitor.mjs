// Exit-only poller for an always-on Node 22+ host. Never signs or sends transactions.
const origin=process.env.DESK_ORIGIN;
const secret=process.env.FAST_RUNNER_SECRET;
const interval=Math.max(10000,Number(process.env.POLL_INTERVAL_MS)||15000);
if(!origin||!secret||secret.length<32)throw Error('Configure DESK_ORIGIN and a matching FAST_RUNNER_SECRET of at least 32 characters.');
const u=new URL(origin);
if(u.protocol!=='https:'||!u.hostname.endsWith('.base44.app')||u.username||u.password)throw Error('DESK_ORIGIN must be your published HTTPS Base44 app origin.');
const endpoint=u.origin+'/api/apps/6ad7c656869fa3aa4790306f/functions/runTradingCycle';
let stopping=false;
process.on('SIGTERM',()=>{stopping=true;});
process.on('SIGINT',()=>{stopping=true;});
while(!stopping){
 const started=Date.now();
 try {
  const res=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json','X-Desk-Runner-Secret':secret},body:JSON.stringify({mode:'exits-only'}),signal:AbortSignal.timeout(45000)});
  if(res.status===401||res.status===403)throw Error('Runner authentication failed; check matching secrets');
  if(res.status>=500||res.status===409) console.log(new Date().toISOString()+' monitor skipped or failed: HTTP '+res.status);
  else if(!res.ok)console.log(new Date().toISOString()+' monitor HTTP '+res.status);
  else console.log(new Date().toISOString()+' exit-only cycle completed');
 }catch(error){console.log(new Date().toISOString()+' monitor request failed; check hosting, endpoint and secret');}
 await new Promise(r=>setTimeout(r,Math.max(1000,interval-(Date.now()-started))));
}