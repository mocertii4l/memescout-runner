import {spawn} from 'node:child_process';
const workers=['launch-listener.mjs','fast-monitor.mjs'];
let stopping=false;
const children=workers.map(file=>spawn(process.execPath,[file],{stdio:'inherit',env:process.env}));
function stop(code=0){
 if(stopping)return;stopping=true;process.exitCode=code;
 for(const child of children)child.kill('SIGTERM');
 setTimeout(()=>{for(const child of children)child.kill('SIGKILL');process.exit(code);},8000).unref();
}
children.forEach((child,i)=>{
 child.on('error',()=>{console.error(workers[i]+' could not start');stop(1);});
 child.on('exit',()=>{if(!stopping){console.error(workers[i]+' stopped; restarting the service is required');stop(1);}});
});
process.on('SIGTERM',()=>stop(0));
process.on('SIGINT',()=>stop(0));
