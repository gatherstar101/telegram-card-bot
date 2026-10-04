import { DurableObject } from 'cloudflare:workers';
import { timingSafeEqual } from 'node:crypto';
import { botApi } from '../../auto-register/api/conversion.js';
import { Failure } from '../../auto-register/api/errors.js';
import { createStore } from './store.js';
import { createAuthCache } from './auth-state.js';
import { credentials,integer,rate,audit } from './security.js';
import { json,failure,bodyOf } from './http.js';

export class WebhookDelivery extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);this.store=createStore(env.DB,env);this.crypto=credentials(env);this.cache=createAuthCache(env);this.running=false;this.send=botApi;
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS deliveries(id INTEGER PRIMARY KEY,bot_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS deliveries_pending ON deliveries(status,next_at)');
  }
  row(id){return this.ctx.storage.sql.exec('SELECT * FROM deliveries WHERE id=?',id).toArray()[0];}
  public(row){return {update_id:row.id,status:row.status,attempts:row.attempts,updated_at:row.updated_at};}
  async fetch(request) {
    try {
      const body=await bodyOf(request,32768);
      if(body.action==='receive') {
        const {bot_id,secret,update}=body;
        const config=await this.store.webhookBot(bot_id);
        if(!config)throw new Failure(404,'Bot 未配置');
        const supplied=Buffer.from(secret||'');const expected=Buffer.from(config.webhook_secret||'');
        if(!expected.length||supplied.length!==expected.length||!timingSafeEqual(supplied,expected))throw new Failure(403,'Webhook 密钥错误');
        if(!Number.isSafeInteger(update.update_id)||update.update_id<0)throw new Failure(400,'需要有效 update_id');
        const existing=this.row(update.update_id);
        if(existing){await this.schedule();return json({ok:true,duplicate:true,...this.public(existing)});}
        const message=update.message;
        if(message?.chat?.type!=='private'||!/^\/start(?:@\w+)?(?:\s|$)/i.test(message.text||''))return json({ok:true});
        if(!Number.isSafeInteger(message.chat.id))throw new Failure(400,'chat.id 无效');
        try {
          await rate(this.cache,this.env,'webhook-chat',`${bot_id}:${message.chat.id}`,integer(this.env,'WEBHOOK_CHAT_PER_MINUTE',5,1,60));
          await rate(this.cache,this.env,'webhook-bot',bot_id,integer(this.env,'WEBHOOK_BOT_PER_MINUTE',300,1,3000));
        } catch(error){if(error.status===429)return json({ok:true,rate_limited:true});throw error;}
        const payload=this.crypto.seal(JSON.stringify({chat_id:message.chat.id}),`delivery:${bot_id}:${update.update_id}`);
        this.ctx.storage.transactionSync(()=>{
          if(this.row(update.update_id))return;
          const pending=this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM deliveries WHERE status IN ('queued','sending')").one().n;
          if(pending>=integer(this.env,'WEBHOOK_QUEUE_LIMIT',500,1,10000))throw new Failure(503,'Webhook 队列暂时已满');
          this.ctx.storage.sql.exec('INSERT INTO deliveries(id,bot_id,payload,status,next_at,updated_at) VALUES(?,?,?,?,?,?)',update.update_id,bot_id,payload,'queued',Date.now()+1000,Date.now());
        });
        await this.schedule();
        return json({ok:true,status:'queued'});
      }
      const {user_id,auth_version,account_id,username,update_id}=body;
      const user=await this.store.userById(user_id);
      if(!user||user.disabled||(user.auth_version||0)!==(auth_version||0))throw new Failure(401,'登录状态已撤销');
      if(!await this.store.ownsAccount(user_id,account_id))throw new Failure(404,'账号不存在');
      const bot=await this.store.get(account_id,username);
      const row=this.row(update_id);
      if(!bot||!row||bot.token.split(':')[0]!==row.bot_id)throw new Failure(404,'投递记录不存在');
      if(body.action==='retry') {
        if(!['failed','uncertain'].includes(row.status))throw new Failure(409,'投递状态不支持重试');
        if(row.status==='uncertain'&&body.allow_duplicate!==true)throw new Failure(409,'结果未知，重试需要 allow_duplicate=true，可能重复发送');
        this.ctx.storage.transactionSync(()=>{
          const current=this.row(update_id);
          if(!['failed','uncertain'].includes(current.status))throw new Failure(409,'投递状态已经改变');
          if(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM deliveries WHERE status IN ('queued','sending')").one().n>=integer(this.env,'WEBHOOK_QUEUE_LIMIT',500,1,10000))throw new Failure(503,'Webhook 队列暂时已满');
          this.ctx.storage.sql.exec("UPDATE deliveries SET status='queued',attempts=0,next_at=?,updated_at=? WHERE id=?",Date.now()+1000,Date.now(),update_id);
        });
        await this.schedule();
      }
      return json(this.public(this.row(update_id)));
    } catch(error){return failure(error);}
  }
  async schedule(preserve=true) {
    await this.ctx.storage.transaction(async storage=>{
      const ttl=integer(this.env,'WEBHOOK_RETENTION_SECONDS',604800,172800,2592000)*1000;
      this.ctx.storage.sql.exec("DELETE FROM deliveries WHERE status IN ('sent','failed','uncertain') AND updated_at<?",Date.now()-ttl);
      const next=this.ctx.storage.sql.exec("SELECT MIN(next_at) AS at FROM deliveries WHERE status='queued'").one().at;
      const sending=this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM deliveries WHERE status='sending'").one().n;
      const count=this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM deliveries').one().n;
      const at=next!==null?Math.max(Date.now()+1000,next):sending?Date.now()+30000:count?Date.now()+86400000:null;
      const existing=await storage.getAlarm();
      if(at!==null) {if(!preserve||existing===null||at<existing)await storage.setAlarm(at);}
      else await storage.deleteAlarm();
    });
  }

  async alarm() {
    if(this.running)return;
    this.running=true;let failed=false;
    try {
      await this.ctx.storage.setAlarm(Date.now()+30000);
      // sendMessage has no idempotency key. Never automatically resend a
      // previous invocation that may have reached Telegram before a crash.
      this.ctx.storage.sql.exec("UPDATE deliveries SET status='uncertain',updated_at=? WHERE status='sending'",Date.now());
      for(let batch=0;batch<integer(this.env,'WEBHOOK_BATCH_SIZE',10,1,30);batch++) {
        const row=this.ctx.storage.sql.exec("SELECT * FROM deliveries WHERE status='queued' AND next_at<=? ORDER BY next_at LIMIT 1",Date.now()).toArray()[0];
        if(!row)return;
        const config=await this.store.webhookBot(row.bot_id);
        if(!config){this.ctx.storage.sql.exec("UPDATE deliveries SET status='failed',updated_at=? WHERE id=?",Date.now(),row.id);continue;}
        const payload=JSON.parse(this.crypto.open(row.payload,`delivery:${row.bot_id}:${row.id}`));
        this.ctx.storage.sql.exec("UPDATE deliveries SET status='sending',attempts=attempts+1,updated_at=? WHERE id=?",Date.now(),row.id);
        try {
          await this.send(config.token,config.card_image?'sendPhoto':'sendMessage',{
            chat_id:payload.chat_id,...(config.card_image?{photo:config.card_image,caption:config.card_text}:{text:config.card_text}),
            reply_markup:{inline_keyboard:[[{text:config.button_text,url:config.landing_url}]]},
          });
          this.ctx.storage.sql.exec("UPDATE deliveries SET status='sent',updated_at=? WHERE id=?",Date.now(),row.id);
          audit('webhook_delivered',{bot_id:row.bot_id,update_id:row.id});
        } catch(error) {
          if(error.telegram_code===429&&row.attempts<4) {
            const delay=Math.max(1,Math.min(error.retry_after||30,86400))*1000;
            this.ctx.storage.sql.exec("UPDATE deliveries SET status='queued',next_at=?,updated_at=? WHERE id=?",Date.now()+delay,Date.now(),row.id);
          } else {
            const status=error.telegram_code>=400&&error.telegram_code<500?'failed':'uncertain';
            this.ctx.storage.sql.exec('UPDATE deliveries SET status=?,updated_at=? WHERE id=?',status,Date.now(),row.id);
            audit('webhook_delivery_error',{bot_id:row.bot_id,update_id:row.id,status});
          }
        }
      }
    } catch(error) {
      failed=true;
      audit('webhook_alarm_error',{kind:'storage_or_runtime'});
      await this.ctx.storage.setAlarm(Date.now()+30000);
    } finally {this.running=false;if(!failed)await this.schedule(false);}
  }
}
