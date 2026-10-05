import { timingSafeEqual,createHmac,randomUUID } from 'node:crypto';
import { Failure } from './errors.js';
import { botApi } from './conversion.js';
import { credentials,integer,rate,audit } from './security.js';
import { queueStore,withLease } from './queue-store.js';
import { trackedLink } from './tracking.js';

export class Deliveries {
  constructor(store,auth,env,send=botApi){this.store=store;this.auth=auth;this.env=env;this.send=send;this.crypt=credentials(env);this.queue=queueStore(store,'webhook_deliveries','sending');this.lastCleanup=0;}
  view(row){if(!row)throw new Failure(404,'投递不存在');return {bot_id:row.bot_id,update_id:row.update_id,status:row.status,attempts:row.attempts,updated_at:Number(row.updated_at)};}
  async receive(botId,secret,update){
    const config=await this.store.webhookBot(botId);if(!config)throw new Failure(404,'Bot 未配置');
    if(typeof config.webhook_secret!=='string'||config.webhook_secret.length<32)throw new Failure(503,'Webhook 密钥未配置');
    const provided=Buffer.from(secret||'');const expected=Buffer.from(config.webhook_secret||'');if(provided.length!==expected.length||!timingSafeEqual(provided,expected))throw new Failure(403,'Webhook 密钥错误');
    if(!Number.isSafeInteger(update.update_id)||update.update_id<0)throw new Failure(400,'update_id 无效');
    let epoch;
    if(this.store.assertBusiness)try{epoch=await this.store.assertBusiness(config.user_id);}catch(error){if(error.code==='USER_DISABLED')return {ok:true,ignored:true};throw error;}
    const policy=this.store.botPolicy?await this.store.botPolicy(botId):null;
    if(policy&&(policy.status!=='active'||policy.environment==='production'&&!policy.published_version))return {ok:true,ignored:true};
    const message=update.message;
    if(policy?.environment==='test'&&!policy.config.test_user_ids.includes(String(message?.from?.id)))return {ok:true,ignored:true};
    if(message?.chat?.type!=='private'||!/^\/start(?:@\w+)?(?:\s|$)/i.test(message.text||'')){
      if(this.store.event){await this.store.event({user_id:config.user_id,project_id:policy?.id||null,bot_id:botId,environment:policy?.environment||'production',type:'telegram_update',event_key:`update:${botId}:${update.update_id}`,data:{update_id:update.update_id,telegram_user_id:message?.from?.id?String(message.from.id):null,chat_type:message?.chat?.type||null},raw_update:integer(this.env,'RAW_UPDATE_RETENTION_DAYS',7,0,90)>0?update:null});if(this.store.visitor)await this.store.visitor(config.user_id,botId,message?.from);}
      return {ok:true};
    }
    if(!Number.isSafeInteger(message.chat.id))throw new Failure(400,'chat.id 无效');
    if(policy?.environment==='test'&&!policy.config.test_user_ids.includes(String(message.from?.id)))return {ok:true,ignored:true};
    const source=message.text.match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{1,64})\s*$/i)?.[1]||null;
    const id=String(update.update_id);
    const result=await withLease(this.auth.cache,`${this.env.REDIS_KEY_PREFIX||'telegram-bot:'}delivery-enqueue:${botId}`,async()=>{
      if(await this.queue.one('SELECT update_id FROM webhook_deliveries WHERE bot_id=? AND update_id=?',[botId,id]))return {ok:true,duplicate:true};
      try{await rate(this.auth.cache,this.env,'webhook-chat',`${botId}:${message.chat.id}`,integer(this.env,'WEBHOOK_CHAT_PER_MINUTE',5,1,60));await rate(this.auth.cache,this.env,'webhook-bot',botId,integer(this.env,'WEBHOOK_BOT_PER_MINUTE',300,1,3000));}
      catch(error){if(error.status===429)return {ok:true,rate_limited:true};throw error;}
      const n=await this.queue.one("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE bot_id=? AND status IN ('queued','sending')",[botId]);if(Number(n.n)>=integer(this.env,'WEBHOOK_QUEUE_LIMIT',500,1,10000))throw new Failure(503,'投递队列已满');
      const now=Date.now();const payload={chat_id:message.chat.id,telegram_user_id:message.from?.id?String(message.from.id):null,source,business_epoch:epoch,project_id:policy?.id||null,project_epoch:policy?.epoch,environment:policy?.environment||'production',version:policy?.version||null};
      const write=async connection=>{
        await connection.execute('INSERT INTO webhook_deliveries(bot_id,update_id,payload,status,next_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',[botId,id,this.crypt.seal(JSON.stringify(payload),`delivery:${botId}:${id}`),'queued',now,now,now]);
        if(this.store.event)await this.store.event({user_id:config.user_id,project_id:payload.project_id,bot_id:botId,environment:payload.environment,type:'bot_start',event_key:`start:${botId}:${id}`,source,data:{telegram_user_id:payload.telegram_user_id,chat_id:String(message.chat.id),version:payload.version},raw_update:integer(this.env,'RAW_UPDATE_RETENTION_DAYS',7,0,90)>0?update:null},connection);
      };
      if(this.store.transaction)await this.store.transaction(write);else await write(this.store.pool);
      if(this.store.visitor)await this.store.visitor(config.user_id,botId,message.from);
      return {ok:true};
    },30);
    if(result.busy)throw new Failure(503,'Webhook 正在接收，请稍后重投');return result.value;
  }
  async owned(user,account,username,id){const bot=await this.store.get(account,username);if(!bot||!await this.store.ownsAccount(user.id,account))throw new Failure(404,'Bot 不存在');const row=await this.queue.one('SELECT * FROM webhook_deliveries WHERE bot_id=? AND update_id=?',[bot.token.split(':')[0],id]);if(!row)throw new Failure(404,'投递不存在');return row;}
  async retry(row,allowDuplicate){
    const locked=await withLease(this.auth.cache,`${this.env.REDIS_KEY_PREFIX||'telegram-bot:'}delivery-enqueue:${row.bot_id}`,async()=>{
      const current=await this.queue.one('SELECT * FROM webhook_deliveries WHERE bot_id=? AND update_id=?',[row.bot_id,row.update_id]);
      if(!['failed','uncertain'].includes(current?.status))throw new Failure(409,'当前状态不能重试');if(current.status==='uncertain'&&allowDuplicate!==true)throw new Failure(409,'结果未知，重试需明确 allow_duplicate=true');
      const n=await this.queue.one("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE bot_id=? AND status IN ('queued','sending')",[row.bot_id]);if(Number(n.n)>=integer(this.env,'WEBHOOK_QUEUE_LIMIT',500,1,10000))throw new Failure(503,'投递队列已满');
      const payload=JSON.parse(this.crypt.open(current.payload,`delivery:${row.bot_id}:${row.update_id}`));
      if(this.store.assertBusiness){const config=await this.store.webhookBot(row.bot_id);if(!config)throw new Failure(404,'Bot 不存在');payload.business_epoch=await this.store.assertBusiness(config.user_id);const policy=await this.store.botPolicy(row.bot_id);if(policy&&policy.status!=='active')throw new Failure(409,'项目未启用','PROJECT_INACTIVE');if(policy)payload.project_epoch=policy.epoch;}
      await this.queue.update(current,{payload:this.crypt.seal(JSON.stringify(payload),`delivery:${row.bot_id}:${row.update_id}`),status:'queued',attempts:0,lease:null,lease_until:0,next_at:Date.now(),updated_at:Date.now()});return this.view({...current,status:'queued',attempts:0});
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
      try{
        const businessEpoch=payload.business_epoch??0;
        if(this.store.assertBusiness)await this.store.assertBusiness(config.user_id,businessEpoch);
        const policy=this.store.botPolicy?await this.store.botPolicy(row.bot_id):null;
        if(policy&&(policy.status!=='active'||policy.environment==='production'&&!policy.published_version||policy.environment==='test'&&!policy.config.test_user_ids.includes(payload.telegram_user_id)))throw new Failure(403,'资源业务已停止','PROJECT_INACTIVE');
        const landing=payload.project_id?(await this.store.projectConfig(payload.project_id,payload.version)).landing:config;
        const link=this.trackedLink(row.bot_id,payload,landing.landing_url);
        const action=()=>this.send(config.token,landing.card_image?'sendPhoto':'sendMessage',{chat_id:payload.chat_id,...(landing.card_image?{photo:landing.card_image,caption:landing.card_text}:{text:landing.card_text}),reply_markup:{inline_keyboard:[[{text:landing.button_text,url:link}]]}});
        if(this.store.dispatch)await this.store.dispatch(config.user_id,businessEpoch,'card_send',action,payload.project_id,payload.project_epoch);else await action();
        await this.finish(row,'sent');
        if(this.store.event)await this.store.event({user_id:config.user_id,project_id:payload.project_id,bot_id:row.bot_id,environment:payload.environment,type:'card_sent',event_key:`sent:${row.bot_id}:${row.update_id}`,source:payload.source,data:{telegram_user_id:payload.telegram_user_id,version:payload.version}});
      }
      catch(error){if(['USER_DISABLED','BUSINESS_REVOKED','PROJECT_INACTIVE'].includes(error.code))await this.finish(row,'cancelled');else if(error.telegram_code===429&&row.attempts<5)await this.finish(row,'queued',Date.now()+Math.max(1,Math.min(86400,error.retry_after||30))*1000);else await this.finish(row,error.telegram_code>=400&&error.telegram_code<500?'failed':'uncertain');}
    },60);
    if(result.busy){if(row.previous_status==='sending')await this.finish(row,'uncertain');else await this.queue.update(row,{status:'queued',lease:null,lease_until:0,next_at:Date.now()+1000},true);}
  }
  trackedLink(botId,payload,fallback) {
    return trackedLink(this.env,botId,payload,fallback);
  }
  async redirect(token,context) {
    if(typeof token!=='string'||token.length>1024)throw new Failure(400,'链接无效');
    const [data,signature,...extra]=token.split('.');const expected=createHmac('sha256',this.env.AUTH_HMAC_SECRET).update(data||'').digest();let value;
    try{const actual=Buffer.from(signature||'','base64url');if(extra.length||actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new Error();value=JSON.parse(Buffer.from(data,'base64url').toString());}catch{throw new Failure(400,'链接签名无效');}
    if(value.exp!==null&&(!Number.isFinite(value.exp)||value.exp<Date.now()))throw new Failure(410,'链接已过期','LINK_EXPIRED','open_bot');
    const config=await this.store.webhookBot(value.bot);if(!config)throw new Failure(404,'Bot 不存在');
    await this.store.assertBusiness(config.user_id,value.epoch);const policy=await this.store.botPolicy(value.bot);
    if(!policy||policy.id!==value.project||policy.environment!==value.environment||policy.status!=='active'||value.environment==='production'&&!policy.published_version)throw new Failure(403,'业务已停止','PROJECT_INACTIVE');
    const version=await this.store.projectConfig(policy.id,value.version);
    return this.store.dispatch(config.user_id,value.epoch,'landing_redirect',async()=>{await this.store.event({user_id:config.user_id,project_id:policy.id,bot_id:value.bot,environment:value.environment,type:'link_visit',event_key:`click:${randomUUID()}`,source:value.source,data:{version:value.version,...context}});return version.landing.landing_url;},policy.id,value.project_epoch);
  }
}
