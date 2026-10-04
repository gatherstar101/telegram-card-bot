import { DurableObject } from 'cloudflare:workers';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { createService } from '../../auto-register/api/service.js';
import { Failure } from '../../auto-register/api/errors.js';
import { createStore } from './store.js';
import { createAuthRuntime } from './auth-runtime.js';
import { TelegramSocket } from './telegram-socket.js';
import { json,failure,bodyOf } from './http.js';

export function createTelegramClient(state) {
  const client = new TelegramClient(new StringSession(state.session || ''),state.api_id,state.api_hash,{
    networkSocket:TelegramSocket,connectionRetries:2,requestRetries:2,autoReconnect:false,
    receiveUpdates:false,floodSleepThreshold:0,
  });
  client.setLogLevel('none');
  return client;
}

export class TelegramAccount extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.store = createStore(env.DB);
    this.service = createService({
      store:this.store,auth:createAuthRuntime(this.store,env),env,
      connected:async (state,operation) => {
        const client = createTelegramClient(state);
        try { await client.connect(); return await operation(client); }
        finally { state.session = client.session.save(); await client.destroy(); }
      },
    });
  }
  async fetch(request) {
    try {
      const {method,path,body,user_id} = await bodyOf(request,32768);
      const user = await this.store.userById(user_id);
      if (!user) throw new Failure(401,'用户不存在');
      return json(await this.service.route(method,path,body,user));
    } catch (error) { return failure(error); }
  }
}
