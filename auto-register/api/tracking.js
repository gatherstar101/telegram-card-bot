import { createHmac } from 'node:crypto';
import { integer } from './security.js';

export function trackedLink(env,botId,payload,fallback) {
  if(!payload.project_id||!env.PUBLIC_BASE_URL)return fallback;
  const data=Buffer.from(JSON.stringify({bot:botId,project:payload.project_id,environment:payload.environment,version:payload.version,epoch:payload.business_epoch,project_epoch:payload.project_epoch,source:payload.source||null,exp:payload.persistent?null:Date.now()+integer(env,'TRACKING_LINK_TTL_SECONDS',86400,60,604800)*1000})).toString('base64url');
  const signature=createHmac('sha256',env.AUTH_HMAC_SECRET).update(data).digest('base64url');
  return `${new URL(env.PUBLIC_BASE_URL).origin}/r/${data}.${signature}`;
}
