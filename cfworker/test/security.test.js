import { beforeEach,afterEach,it,expect,vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import worker from '../src/index.js';
import { credentials } from '../src/security.js';
beforeEach(async()=>{await reset();vi.spyOn(console,'log').mockImplementation(()=>{});});
afterEach(()=>vi.restoreAllMocks());
it('fails readiness closed for missing keys or unavailable storage without exposing details',async()=>{
  for(const overridden of [{CREDENTIAL_KEYS:''},{MAIL_API_KEY:''},{DB:{prepare(){throw new Error('sensitive database details');},batch(){throw new Error('down');}}}]) {
    const response=await worker.fetch(new Request('https://example.test/ready'),{...env,...overridden});
    expect(response.status).toBe(503);expect(await response.json()).toEqual({ok:false});expect(response.headers.get('X-Request-ID')).toMatch(/^[a-f0-9-]{36}$/);
  }
  expect((await worker.fetch(new Request('https://example.test/health'),{...env,DB:null})).status).toBe(200);
});
it('rejects ciphertext tampering, wrong account context and missing decryption keys',()=>{
  const cipher=credentials(env),encrypted=cipher.seal('sensitive','account-a:session');expect(cipher.open(encrypted,'account-a:session')).toBe('sensitive');
  expect(()=>cipher.open(encrypted,'account-b:session')).toThrow();
  const parts=encrypted.split(':');parts[4]=Buffer.from('tampered').toString('base64');expect(()=>cipher.open(parts.join(':'),'account-a:session')).toThrow();
  expect(()=>cipher.open(encrypted.replace('test-v1','missing'),'account-a:session')).toThrow();
  expect(()=>credentials({...env,CREDENTIAL_KEYS:JSON.stringify({'test-v1':'short'})})).toThrow();
});
