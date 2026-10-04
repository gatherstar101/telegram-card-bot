// Redis Lua preserves atomic counter expiry and owner-checked lock release.
export function createCache(redis) {
  return {
    get: key => redis.get(key), ttl: key => redis.ttl(key),
    set: (key,value,options) => redis.set(key,value,options), del:key=>redis.del(key),
    increment:(key,seconds)=>redis.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",{keys:[key],arguments:[String(seconds)]}),
    release:(key,lease)=>redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0",{keys:[key],arguments:[lease]}),
  };
}
