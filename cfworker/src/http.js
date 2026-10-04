import { Failure } from '../../auto-register/api/errors.js';

export const json = (value,status=200) => Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
export function failure(error) {
  const status = error.status || (error.errorMessage?.startsWith('FLOOD_WAIT') ? 429 : error.errorMessage ? 422 : 500);
  const response=json({error:error.status?error.message:error.errorMessage||'服务内部错误',...(error.retry_after?{retry_after:error.retry_after}:{})},status);
  if(status===429&&error.retry_after)response.headers.set('Retry-After',String(Math.max(1,Math.ceil(error.retry_after))));
  return response;
}
export async function bodyOf(request,maximum=16384) {
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Failure(413,'请求体过大'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  let body;
  try { body = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
  catch { throw new Failure(400,'JSON 格式错误'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Failure(400,'请求体必须为 JSON 对象');
  return body;
}
