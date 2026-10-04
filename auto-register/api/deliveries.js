import { timingSafeEqual } from 'node:crypto';
import { Failure } from './errors.js';
import { botApi } from './conversion.js';
import { credentials,integer,rate,audit } from './security.js';
import { queueStore,withLease } from './queue-store.js';

export class Deliveries {
  constructor(store,auth,env,send=botApi){this.store=store;this.auth=auth;this.env=env;this.send=send;this.crypt=credentials(env);this.queue=queueStore(store,'webhook_deliveries','sending');this.lastCleanup=0;}
  view(row){if(!row)throw new Failure(404,'投递不存在');return {bot_id:row.bot_id,update_id:row.update_id,status:row.status,attempts:row.attempts,updated_at:Number(row.updated_at)};}
  async receive(botId,secret,update){
    const config=await this.store.webhookBot(botId);if(!config)throw new Failure(404,'Bot 未配置');
    if(typeof config.webhook_secret!=='string'||config.webhook_secret.length<32)throw new Failure(503,'Webhook 密钥未配置');
    const provided=Buffer.from(secret||'');const expected=Buffer.from(config.webhook_secret||'');if(provided.length!==expected.length||!timingSafeEqual(provided,expected))throw new Failure(403,'Webhook 密钥错误');
    if(!Number.isSafeInteger(update.update_id)||update.update_id<0)throw new Failure(400,'update_id 无效');
    const message=update.message;if(message?.chat?.type!=='private'||!/^\/start(?:@\w+)?(?:\s|$)/i.test(message.text||''))return {ok:true};
    if(!Number.isSafeInteger(message.chat.id))throw new Failure(400,'chat.id 无效');
    const id=String(update.update_id);
    const result=await withLease(this.auth.cache,`${this.env.REDIS_KEY_PREFIX||'telegram-bot:'}delivery-enqueue:${botId}`,async()=>{
      if(await this.queue.one('SELECT update_id FROM webhook_deliveries WHERE bot_id=? AND update_id=?',[botId,id]))return {ok:true,duplicate:true};
      try{await rate(this.auth.cache,this.env,'webhook-chat',`${botId}:${message.chat.id}`,integer(this.env,'WEBHOOK_CHAT_PER_MINUTE',5,1,60));await rate(this.auth.cache,this.env,'webhook-bot',botId,integer(this.env,'WEBHOOK_BOT_PER_MINUTE',300,1,3000));}
      catch(error){if(error.status===429)return {ok:true,rate_limited:true};throw error;}
      const n=await this.queue.one("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE bot_id=? AND status IN ('queued','sending')",[botId]);if(Number(n.n)>=integer(this.env,'WEBHOOK_QUEUE_LIMIT',500,1,10000))throw new Failure(503,'投递队列已满');
      const now=Date.now();await this.store.pool.execute('INSERT INTO webhook_deliveries(bot_id,update_id,payload,status,next_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',[botId,id,this.crypt.seal(JSON.stringify({chat_id:message.chat.id}),`delivery:${botId}:${id}`),'queued',now,now,now]);return {ok:true};
    },30);
    if(result.busy)throw new Failure(503,'Webhook 正在接收，请稍后重投');return result.value;
  }
  async owned(user,account,username,id){const bot=await this.store.get(account,username);if(!bot||!await this.store.ownsAccount(user.id,account))throw new Failure(404,'Bot 不存在');const row=await this.queue.one('SELECT * FROM webhook_deliveries WHERE bot_id=? AND update_id=?',[bot.token.split(':')[0],id]);if(!row)throw new Failure(404,'投递不存在');return row;}
  async retry(row,allowDuplicate){
    const locked=await withLease(this.auth.cache,`${this.env.REDIS_KEY_PREFIX||'telegram-bot:'}delivery-enqueue:${row.bot_id}`,async()=>{
      const current=await this.queue.one('SELECT * FROM webhook_deliveries WHERE bot_id=? AND update_id=?',[row.bot_id,row.update_id]);
      if(!['failed','uncertain'].includes(current?.status))throw new Failure(409,'当前状态不能重试');if(current.status==='uncertain'&&allowDuplicate!==true)throw new Failure(409,'结果未知，重试需明确 allow_duplicate=true');
      const n=await this.queue.one("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE bot_id=? AND status IN ('queued','sending')",[row.bot_id]);if(Number(n.n)>=integer(this.env,'WEBHOOK_QUEUE_LIMIT',500,1,10000))throw new Failure(503,'投递队列已满');
      await this.queue.update(current,{status:'queued',attempts:0,lease:null,lease_until:0,next_at:Date.now(),updated_at:Date.now()});return this.view({...current,status:'queued',attempts:0});
    },30);if(locked.busy)throw new Failure(409,'投递正在处理');return locked.value;
  }
  async finish(row,status,nextAt=Date.now()){await this.queue.update(row,{status,attempts:row.attempts,lease:null,lease_until:0,next_at:nextAt,updated_at:Date.now()},true);audit('webhook_delivery_finished',{bot_id:row.bot_id,update_id:row.update_id,status});}
  async runOnce(){
    if(Date.now()-this.lastCleanup>3600000){await this.queue.cleanup(integer(this.env,'WEBHOOK_RETENTION_SECONDS',604800,172800,2592000));this.lastCleanup=Date.now();}
    const row=await this.queue.claim(60);if(!row)return;
    const result=await withLease(this.auth.cache,`${this.env.REDIS_KEY_PREFIX||'telegram-bot:'}delivery-send:${row.bot_id}`,async()=>{
      if(row.previous_status==='sending'){await this.finish(row,'uncertain');return;}
      const config=await this.store.webhookBot(row.bot_id);if(!config){await this.finish(row,'failed');return;}
      const payload=JSON.parse(this.crypt.open(row.payload,`delivery:${row.bot_id}:${row.update_id}`));row.attempts++;
      try{await this.send(config.token,config.card_image?'sendPhoto':'sendMessage',{chat_id:payload.chat_id,...(config.card_image?{photo:config.card_image,caption:config.card_text}:{text:config.card_text}),reply_markup:{inline_keyboard:[[{text:config.button_text,url:config.landing_url}]]}});await this.finish(row,'sent');}
      catch(error){if(error.telegram_code===429&&row.attempts<5)await this.finish(row,'queued',Date.now()+Math.max(1,Math.min(86400,error.retry_after||30))*1000);else await this.finish(row,error.telegram_code>=400&&error.telegram_code<500?'failed':'uncertain');}
    },60);
    if(result.busy){if(row.previous_status==='sending')await this.finish(row,'uncertain');else await this.queue.update(row,{status:'queued',lease:null,lease_until:0,next_at:Date.now()+1000},true);}
  }
}
