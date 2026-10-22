// Read-only creation feed. No paid trade-event subscriptions, signing or broadcast.
const origin=new URL(process.env.DESK_ORIGIN||'https://invalid.invalid');
const secret=process.env.FAST_RUNNER_SECRET||'';
if(origin.protocol!=='https:'||!origin.hostname.endsWith('.base44.app')||secret.length<32)throw Error('Set published DESK_ORIGIN and matching FAST_RUNNER_SECRET (32+ characters).');
const endpoint=origin.origin+'/api/apps/6ad7c656869fa3aa4790306f/functions/launchLab';
const queue=[];let dropped=0,socket,stopping=false,backoff=1000,connected=false;
let lastMessage=Date.now();
function connect(){
 if(stopping)return;
 const u=new URL('wss://pumpportal.fun/api/data');
 if(process.env.PUMPPORTAL_API_KEY)u.searchParams.set('api-key',process.env.PUMPPORTAL_API_KEY);
 socket=new WebSocket(u);
 socket.addEventListener('open',()=>{connected=true;backoff=1000;lastMessage=Date.now();socket.send(JSON.stringify({method:'subscribeNewToken'}));console.log('Creation stream connected; subscription requested');});
 socket.addEventListener('message',event=>{
  lastMessage=Date.now();
  try{
   const m=JSON.parse(event.data);
   if(m.txType!=='create'||!m.mint)return;
   if(queue.length>=100){queue.shift();dropped++;}
   queue.push({address:m.mint,symbol:m.symbol,signature:m.signature,source:'pumpportal-creation',received_at:new Date().toISOString()});
  }catch{}
 });
 socket.addEventListener('error',()=>{connected=false;socket.close();});
 socket.addEventListener('close',()=>{connected=false;if(!stopping){setTimeout(connect,backoff+Math.random()*500);backoff=Math.min(60000,backoff*2);}});
}
function stop(){stopping=true;socket?.close();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);connect();
while(!stopping){
 if(Date.now()-lastMessage>90000)socket?.close();
 // Expired queued signals are counted as dropped, never silently replayed as new launches.
 while(queue.length&&Date.now()-Date.parse(queue[0].received_at)>55000){queue.shift();dropped++;}
 const batch=queue.splice(0,10),batchDropped=dropped;dropped=0;
 try{
  const r=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json','X-Desk-Runner-Secret':secret},
   body:JSON.stringify({events:batch,stream_connected:connected,dropped:batchDropped}),signal:AbortSignal.timeout(45000)});
  if(r.status===401||r.status===403){console.error('Launch runner authentication failed; stopping.');stop();process.exitCode=1;}
  else if(!r.ok){queue.unshift(...batch);dropped+=batchDropped;console.log('Launch cycle unavailable: HTTP '+r.status);}
  else{const b=await r.json();if(b.waiting){queue.unshift(...batch);dropped+=batchDropped;}console.log('Launch paper cycle completed; received batch '+batch.length);}
 }catch{queue.unshift(...batch);dropped+=batchDropped;console.log('Launch endpoint unavailable; queued signals expire after 55 seconds.');}
 await new Promise(r=>setTimeout(r,15000));
}