// Independent paper scalper and V1 exit loops. Never signs or sends transactions.
const origin=process.env.DESK_ORIGIN?.trim();
const secret=process.env.FAST_RUNNER_SECRET?.trim();
function cadence(raw,fallback,min){const n=Number(raw);return Number.isFinite(n)&&n>0?Math.max(min,n):fallback;}
const scalpInterval=cadence(process.env.SCALP_INTERVAL_MS,5000,5000);
const mainInterval=cadence(process.env.POLL_INTERVAL_MS,15000,10000);
const discoveryInterval=cadence(process.env.DISCOVERY_INTERVAL_MS,60000,60000);
if(!origin||!secret||secret.length<32)throw Error('Configure DESK_ORIGIN and a matching FAST_RUNNER_SECRET of at least 32 characters.');
const u=new URL(origin);
if(u.protocol!=='https:'||!u.hostname.endsWith('.base44.app')||u.username||u.password)throw Error('DESK_ORIGIN must be your published HTTPS Base44 app origin.');
const base=u.origin+'/api/apps/6ad7c656869fa3aa4790306f/functions/';
let stopping=false,backendCooldownUntil=0;
process.on('SIGTERM',()=>{stopping=true;});
process.on('SIGINT',()=>{stopping=true;});
console.log('Paper monitor cadence: scalper '+scalpInterval+'ms; V1 exits '+mainInterval+'ms; discovery '+discoveryInterval+'ms; independent loops');
async function poll(name,interval,body){
 while(!stopping){
  while(!stopping&&Date.now()<backendCooldownUntil)await new Promise(resolve=>setTimeout(resolve,Math.min(1000,backendCooldownUntil-Date.now())));
  if(stopping)break;
  const started=Date.now();let backoff=0;
  try{
   const r=await fetch(base+name,{method:'POST',headers:{'content-type':'application/json','X-Desk-Runner-Secret':secret},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
   const detail=await r.json().catch(()=>({}));
   const code=['SERVER_SECRET_MISSING','SERVER_SECRET_TOO_SHORT','RUNNER_HEADER_MISSING','RUNNER_SECRET_MISMATCH'].includes(detail.code)?detail.code:'';
   console.log(new Date().toISOString()+' '+(name==='scalper'?'paper scalper':body.mode==='paper-discovery'?'paper discovery':'V1 exit monitor')+' HTTP '+r.status+(code?' '+code:'')+' duration '+(Date.now()-started)+'ms');
   if(r.status===401||r.status===403)backoff=60000;
   else if(r.status===429)backoff=Math.max(30000,Math.min(300000,(Number(r.headers.get('retry-after'))||30)*1000));
   else if(r.status>=500)backoff=15000;
   if(r.status===429)backendCooldownUntil=Math.max(backendCooldownUntil,Date.now()+backoff);
   // Idle books do not need five-second database sweeps. Open scalp positions retain the fast cadence.
   if(r.ok&&name==='scalper'&&detail.open_positions===0)backoff=Math.max(backoff,30000);
  }catch{backoff=15000;console.log(new Date().toISOString()+' '+name+' request failed; backing off');}
  // No overlapping calls to the same endpoint, even when a cycle exceeds its target cadence.
  const pause=Math.max(1000,interval-(Date.now()-started),backoff);
  const end=Date.now()+pause;
  while(!stopping&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,Math.min(1000,end-Date.now())));
 }
}
async function discovery(){
 // Offset the first scan from the exit tick to reduce lock collisions.
 await new Promise(resolve=>setTimeout(resolve,2500));
 if(!stopping)await poll('runTradingCycle',discoveryInterval,{mode:'paper-discovery'});
}
await Promise.all([poll('scalper',scalpInterval,{}),poll('runTradingCycle',mainInterval,{mode:'exits-only'}),discovery()]);
