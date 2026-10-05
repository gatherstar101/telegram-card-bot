// Redis Lua preserves atomic counter expiry and owner-checked lock release.
export function createCache(redis) {
  return {
    get: key => redis.get(key), ttl: key => redis.ttl(key),
    set: (key,value,options) => redis.set(key,value,options), del:key=>redis.del(key),
    increment:(key,seconds)=>redis.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",{keys:[key],arguments:[String(seconds)]}),
    release:(key,lease)=>redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0",{keys:[key],arguments:[lease]}),
    adminIPBanTTL:(key,maximum)=>redis.eval(`
      local failures=tonumber(redis.call('GET',KEYS[1]) or '0')
      if failures>=tonumber(ARGV[1]) then return math.max(1,redis.call('TTL',KEYS[1])) end
      return 0
    `,{keys:[key],arguments:[String(maximum)]}),
    adminAuthFailure:(key,maximum,seconds)=>redis.eval(`
      local failures=tonumber(redis.call('GET',KEYS[1]) or '0')
      if failures>=tonumber(ARGV[1]) then return math.max(1,redis.call('TTL',KEYS[1])) end
      failures=failures+1
      if failures==1 or failures>=tonumber(ARGV[1]) then
        redis.call('SET',KEYS[1],tostring(failures),'EX',ARGV[2])
      else redis.call('SET',KEYS[1],tostring(failures),'KEEPTTL') end
      if failures>=tonumber(ARGV[1]) then return tonumber(ARGV[2]) end
      return 0
    `,{keys:[key],arguments:[String(maximum),String(seconds)]}),
  };
}
