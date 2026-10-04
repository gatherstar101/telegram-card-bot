import { DurableObject } from 'cloudflare:workers';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { createService } from '../../auto-register/api/service.js';
import { Failure } from '../../auto-register/api/errors.js';
import { createStore } from './store.js';
import { createAuthRuntime } from './auth-runtime.js';
import { TelegramSocket } from './telegram-socket.js';
import { json,failure,bodyOf } from './http.js';
import { JobQueue } from './jobs.js';
import { integer,audit } from './security.js';
import { createAuthCache } from './auth-state.js';
import { randomUUID } from 'node:crypto';

export function createTelegramClient(state) {
  const client=new TelegramClient(new StringSession(state.session||''),state.api_id,state.api_hash,{
    networkSocket:TelegramSocket,connectionRetries:2,requestRetries:2,autoReconnect:false,receiveUpdates:false,floodSleepThreshold:0,
  });
  client.setLogLevel('none');return client;
}
export class TelegramAccount extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.store=createStore(env.DB,env);
    this.jobs=new JobQueue(ctx,env,this.store,async(method,path,body,user)=>{
      const kind=/\/bots$/.test(path)?'bot':/\/channels$/.test(path)?'channel':null;
      if(!kind)return this.service.route(method,path,body,user);
      const cache=createAuthCache(env);const key=`${env.AUTH_STATE_PREFIX||'telegram-bot:'}create-user:${user.id}`;const lease=randomUUID();
      if(!await cache.set(key,lease,{NX:true,EX:600}))throw new Failure(409,'该用户已有创建操作，请稍后重试任务');
      try {
        const existing=kind==='bot'?await this.store.get(path.split('/')[3],body.username):await this.store.getChannel(path.split('/')[3],body.request_key);
        const count=kind==='bot'?await this.store.botCount(user.id):await this.store.channelCount(user.id);
        if(!existing&&count>=integer(env,kind==='bot'?'MAX_BOTS_PER_USER':'MAX_CHANNELS_PER_USER',kind==='bot'?20:50,1,1000))throw new Failure(429,'资源数量达到用户配额');
        return await this.service.route(method,path,body,user);
      } finally {await cache.release(key,lease);}
    });
    this.service=createService({store:this.store,auth:createAuthRuntime(this.store,env),env,
      checkpoint:effect=>this.jobs.checkpoint(effect),
      connected:async(state,operation)=>{
        const client=createTelegramClient(state);
        const seconds=this.jobs.active?integer(env,'JOB_TIMEOUT_SECONDS',240,30,240):integer(env,'TELEGRAM_TIMEOUT_SECONDS',60,15,240);
        let timer;
        try {
          return await Promise.race([(async()=>{await client.connect();return operation(client);})(),new Promise((_,reject)=>{
            timer=setTimeout(()=>reject(new Failure(504,'Telegram 操作超时，请查询任务或核对远端结果')),seconds*1000);
          })]);
        } finally {
          clearTimeout(timer);state.session=client.session.save();
          let cleanup;
          try {await Promise.race([client.destroy(),new Promise(resolve=>{cleanup=setTimeout(resolve,5000);})]);}
          finally {clearTimeout(cleanup);}
        }
      },
    });
  }
  async fetch(request) {
    try {
      const {method,path,body,user_id,auth_version}=await bodyOf(request,32768);
      const user=await this.store.userById(user_id);
      if(!user||user.disabled||(user.auth_version||0)!==(auth_version||0))throw new Failure(401,'登录状态已撤销');
      const match=path.match(/^\/v1\/accounts\/([a-f0-9-]{36})\/jobs\/([a-f0-9]{64})(?:\/(retry))?$/);
      if(match) {
        if(method==='GET'&&!match[3])return json(await this.jobs.get(match[2],user,match[1]));
        if(method==='POST'&&match[3]==='retry')return json(await this.jobs.retry(match[2],user,match[1]),202);
        throw new Failure(404,'接口不存在');
      }
      if(method==='POST'&&/^\/v1\/accounts\/[a-f0-9-]{36}\/(bots|channels|channels\/[A-Za-z0-9_-]+\/posts|bots\/[A-Za-z0-9_]+\/reconcile|channels\/[A-Za-z0-9_-]+\/reconcile)$/.test(path)) {
        return json(await this.jobs.enqueue(path,body,user,path.split('/')[3]),202);
      }
      return json(await this.service.route(method,path,body,user));
    } catch(error){audit('account_error',{status:error.status||500,kind:error.status?'expected':'upstream_or_storage'});return failure(error);}
  }
  async alarm(){return this.jobs.alarm();}
}
