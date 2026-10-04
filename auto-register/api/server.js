import http from 'node:http';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { createStore } from './store.js';
import { Failure } from './errors.js';
import { createAuthRuntime } from './auth-runtime.js';
import { createService } from './service.js';
import { createApplication } from './app.js';
import { Jobs,jobContext } from './jobs.js';
import { Deliveries } from './deliveries.js';
import { background } from './queue-store.js';
import { integer,audit,validateConfig } from './security.js';

process.umask(0o077);
const env=process.env;
validateConfig(env);
const store=await createStore(env);
let auth;
try{auth=await createAuthRuntime(store,env);}catch(error){await store.close();throw error;}
async function connected(state,operation){
  const client=new TelegramClient(new StringSession(state.session||''),state.api_id,state.api_hash,{connectionRetries:2,requestRetries:2,autoReconnect:false,receiveUpdates:false,floodSleepThreshold:0});client.setLogLevel('none');
  const seconds=jobContext.getStore()?integer(env,'JOB_TIMEOUT_SECONDS',240,30,240):integer(env,'TELEGRAM_TIMEOUT_SECONDS',60,15,240);let timer;
  try{return await Promise.race([(async()=>{await client.connect();return operation(client);})(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Failure(504,'Telegram 操作超时，请核对远端结果')),seconds*1000);})]);}
  finally{clearTimeout(timer);state.session=client.session.save();let cleanup;try{await Promise.race([client.destroy(),new Promise(resolve=>{cleanup=setTimeout(resolve,5000);})]);}finally{clearTimeout(cleanup);}}
}
let jobs;
const service=createService({store,auth,connected,env,checkpoint:effect=>jobs.checkpoint(effect)});
jobs=new Jobs(store,auth,env,(...args)=>service.route(...args));
const deliveries=new Deliveries(store,auth,env);
const server=http.createServer(createApplication({store,auth,service,jobs,deliveries,env}));
server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
const interval=integer(env,'QUEUE_POLL_INTERVAL_MS',1000,100,10000);
const stopJobs=background(()=>jobs.runOnce(),{interval,onError:()=>audit('job_worker_error',{kind:'storage_or_runtime'})});
const stopDeliveries=background(()=>deliveries.runOnce(),{interval,onError:()=>audit('webhook_worker_error',{kind:'storage_or_runtime'})});
server.listen(integer(env,'PORT',3100,1,65535),'0.0.0.0',()=>audit('service_started'));
let stopping=false;
async function stop(){if(stopping)return;stopping=true;audit('service_stopping');try{await Promise.all([new Promise(resolve=>server.close(resolve)),stopJobs(),stopDeliveries()]);await auth.close();await store.close();audit('service_stopped');}catch{audit('service_shutdown_error');process.exitCode=1;}}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
