import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { digest } from './auth.js';
import { Failure,errorDetails } from './errors.js';
import { integer,validateConfig,rate,requireAdmin,audit,adminIPGuard } from './security.js';
import { isTask } from './jobs.js';
import { withLease } from './queue-store.js';
import { adminOperation,adminRoute } from './admin.js';

export function clientIP(req,env){
  const hops=integer(env,'TRUST_PROXY_HOPS',0,0,10);const direct=req.socket.remoteAddress||'unknown';
  if(!hops)return direct;
  const forwarded=req.headers['x-forwarded-for'];if(typeof forwarded!=='string')return direct;
  const chain=forwarded.split(',').map(v=>v.trim());if(chain.some(v=>!isIP(v))||chain.length<hops)return direct;
  return chain.at(-hops);
}
async function bodyOf(req){let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>16384)throw new Failure(413,'请求体过大');chunks.push(chunk);}let body;try{body=bytes?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};}catch{throw new Failure(400,'JSON 格式错误');}if(!body||typeof body!=='object'||Array.isArray(body))throw new Failure(400,'请求体必须为 JSON 对象');return body;}
export function createApplication({store,auth,service,jobs,deliveries,products,env=process.env}){
  return async(req,res)=>{
    const start=Date.now();const requestId=randomUUID();res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('X-Request-ID',requestId);
    const respond=(status,value)=>{res.writeHead(status);res.end(JSON.stringify(value));};
    let adminContext;
    let adminAuthenticationFailed=false;
    try{
      const url=new URL(req.url,'http://localhost');const path=url.pathname;const method=req.method;
      if(method==='GET'&&path==='/health')return respond(200,{ok:true});
      if(method==='GET'&&path==='/ready'){try{validateConfig(env);if(!env.SMTP_HOST||!env.SMTP_FROM)throw new Error();await Promise.all([store.ready(),auth.ready()]);return respond(200,{ok:true});}catch{return respond(503,{ok:false});}}
      const webhook=path.match(/^\/webhooks\/(\d+)$/);const ip=clientIP(req,env);
      if(path.startsWith('/admin/'))adminContext={request_id:requestId,started_at:start,actor_type:'anonymous',actor_id:null,ip,peer_ip:req.socket.remoteAddress||'unknown',user_agent:[...(req.headers['user-agent']||'').replace(/[\x00-\x1f\x7f]/g,'')].slice(0,512).join(''),method:method.slice(0,8),...adminOperation(method,path)};
      if(adminContext)await adminIPGuard(auth.cache,env,ip);
      await rate(auth.cache,env,webhook?'webhook-ingress':'ingress',ip,integer(env,webhook?'WEBHOOK_IP_PER_MINUTE':'API_IP_PER_MINUTE',webhook?1200:120,1,10000));
      if(method==='POST'&&['/auth/register/start','/auth/login/start','/auth/password/reset/start','/v1/login/start'].includes(path))await rate(auth.cache,env,'code-ip-second',ip,integer(env,'OTP_IP_QPS',1,1,100),1);
      if(method==='GET'&&path.startsWith('/r/')&&deliveries.redirect){const destination=await deliveries.redirect(path.slice(3),{request_id:requestId,ip,user_agent:[...(req.headers['user-agent']||'')].slice(0,512).join('')});res.writeHead(302,{Location:destination,'Referrer-Policy':'no-referrer'});res.end();return;}
      if(path.startsWith('/admin/')){
        if(adminContext.action==='admin.login'){
          let result;
          try{const body=await bodyOf(req);result=await auth.adminLogin(body,ip);}
          catch(error){adminAuthenticationFailed=[400,401,403].includes(error.status);throw error;}
          adminContext.actor_type='admin';adminContext.actor_id=result.user.id;
          await adminIPGuard(auth.cache,env,ip);
          await store.appendAudit({...adminContext,status:200});adminContext.recorded=true;
          return respond(200,result);
        }
        let keyAccepted=false;
        try{requireAdmin({headers:new Headers({Authorization:req.headers.authorization||''})},env);keyAccepted=true;}catch{}
        if(keyAccepted)adminContext.actor_type='api_key';
        else{
          try{
            const {user}=await auth.authenticate(req.headers.authorization);
            adminContext.actor_id=user.id;adminContext.actor_type=user.role==='admin'?'admin':'user';adminContext.actor_auth_version=user.auth_version;
            if(user.role!=='admin')throw new Failure(403,'需要管理员权限');
          }catch(error){adminAuthenticationFailed=[401,403].includes(error.status);throw error;}
        }
        await adminIPGuard(auth.cache,env,ip);
        const body=await bodyOf(req);
        const result=await adminRoute({store,method,path,url,body,context:adminContext});
        if(!adminContext.recorded){await store.appendAudit({...adminContext,status:200});adminContext.recorded=true;}
        return respond(200,result);
      }
      const body=await bodyOf(req);
      if(webhook){if(method!=='POST')throw new Failure(405,'Webhook 仅支持 POST');return respond(200,await deliveries.receive(webhook[1],req.headers['x-telegram-bot-api-secret-token'],body));}
      if(path.startsWith('/auth/')){const result=await auth.route(method,path,body,req.headers.authorization,ip);if(result.user&&store.event)await store.event({user_id:result.user.id,type:path.includes('register')?'platform_registered':'platform_login',data:{request_id:requestId,ip,user_agent:[...(req.headers['user-agent']||'')].slice(0,512).join('')}});return respond(200,result);}
      const {user}=await auth.authenticate(req.headers.authorization);await rate(auth.cache,env,'user',user.id,integer(env,'API_USER_PER_MINUTE',60,1,10000));
      if(store.assertBusiness)await store.assertBusiness(user.id);
      if(products){const result=await products.route(method,path,url,body,user);if(result!==undefined)return respond(method==='POST'&&/\/(provision|publish|rollback|retry)$/.test(path)?202:200,result);}
      if(method==='GET'&&path==='/v1/accounts'){const after=url.searchParams.get('after')||'';if(after&&!/^[a-f0-9-]{36}$/.test(after))throw new Failure(400,'after 无效');const accounts=await store.accountsForUser(user.id,after);return respond(200,{accounts,next_cursor:accounts.length===100?accounts.at(-1).account_id:null});}
      if(method==='POST'&&path==='/v1/login/start'){
        const phone=typeof(body.phone??env.TG_PHONE)==='string'?(body.phone??env.TG_PHONE).trim():'';if(!/^\+\d{7,15}$/.test(phone))throw new Failure(400,'手机号必须包含国际区号，不含空格');
        await rate(auth.cache,env,'telegram-login-user',user.id,integer(env,'TG_LOGIN_PER_TEN_MINUTES',5,1,20),600);await rate(auth.cache,env,'telegram-login-phone',phone,1,60);
        const result=await withLease(auth.cache,`${env.REDIS_KEY_PREFIX||'telegram-bot:'}account-create:${user.id}`,async()=>{const existing=store.phoneAccount?await store.phoneAccount(user.id,phone):null;const maximum=store.userLimit?await store.userLimit(user.id,'MAX_TG_ACCOUNTS_PER_USER'):integer(env,'MAX_TG_ACCOUNTS_PER_USER',5,1,100);if(!existing&&await store.accountCount(user.id)>=maximum)throw new Failure(429,'Telegram 账号数量达到配额','RESOURCE_QUOTA','review');return service.route(method,path,body,user);});if(result.busy)throw new Failure(409,'用户已有登录请求');return respond(200,result.value);
      }
      const accountMatch=path.match(/^\/v1\/accounts\/([a-f0-9-]{36})(?:\/.*)?$/);if(!accountMatch)throw new Failure(404,'接口不存在');const account=accountMatch[1];await auth.requireAccount(user.id,account);
      if(method==='POST'&&path.endsWith('/verify'))await rate(auth.cache,env,'telegram-verify',account,5,600);
      if(method==='POST'&&/\/(bots|channels)$/.test(path))await rate(auth.cache,env,'telegram-create',user.id,integer(env,'TG_CREATE_PER_TEN_MINUTES',10,1,100),600);
      const jobMatch=path.match(/\/jobs\/([a-f0-9]{64})(?:\/(retry))?$/);if(jobMatch){if(method==='GET'&&!jobMatch[2])return respond(200,jobs.view(await jobs.get(jobMatch[1],user,account)));if(method==='POST'&&jobMatch[2])return respond(202,await jobs.retry(jobMatch[1],user,account));throw new Failure(404,'接口不存在');}
      if(method==='POST'&&isTask(path))return respond(202,await jobs.enqueue(path,body,user,account));
      const deliveryMatch=path.match(/\/bots\/([A-Za-z0-9_]+)\/deliveries\/(\d+)(?:\/(retry|reconcile))?$/);if(deliveryMatch){const row=await deliveries.owned(user,account,deliveryMatch[1],deliveryMatch[2]);if(method==='GET'&&!deliveryMatch[3])return respond(200,deliveries.view(row));if(method==='POST'&&deliveryMatch[3]==='retry')return respond(200,await deliveries.retry(row,body.allow_duplicate));if(method==='POST'&&deliveryMatch[3]==='reconcile')return respond(200,await deliveries.reconcile(row));throw new Failure(404,'接口不存在');}
      return respond(200,await service.route(method,path,body,user));
    }catch(error){
      if(adminContext&&adminAuthenticationFailed){
        adminContext.changes={security:{authentication_failed:true}};
        try{await adminIPGuard(auth.cache,env,adminContext.ip,{failed:true});}catch(guardError){error=guardError;}
      }
      if(adminContext&&error.admin_ip_banned)adminContext.changes={security:{...adminContext.changes?.security,ip_banned:true}};
      let status=error.status||(error.errorMessage?.startsWith('FLOOD_WAIT')?429:error.errorMessage?422:500);
      if(adminContext&&!adminContext.recorded){try{await store.appendAudit({...adminContext,status});}catch{audit('admin_audit_storage_error',{request_id:requestId});error=new Failure(503,'审计存储不可用，请稍后重试');status=503;}}
      if(status===429&&error.retry_after)res.setHeader('Retry-After',String(Math.max(1,Math.ceil(error.retry_after))));respond(status,{error:error.status?error.message:'外部操作或服务内部错误',...errorDetails(error,status),request_id:requestId,...(error.retry_after?{retry_after:error.retry_after}:{})});}
    finally{audit('request_completed',{request_id:requestId,status:res.statusCode,duration_ms:Date.now()-start});}
  };
}
