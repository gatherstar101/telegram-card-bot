import test from 'node:test';
import assert from 'node:assert/strict';
import bigInt from 'big-integer';
import { createConversion, landingConfig } from '../api/conversion.js';

function harness() {
  const db = { landing: null, channel: null, post: null };
  const bot = { username: 'example_bot', name: 'Example', token: '123:TEST_TOKEN' };
  const store = {
    get: async (id, user) => user === bot.username ? bot : null,
    getLanding: async () => db.landing,
    configureLanding: async (id, user, config) => {db.landing = {...config, bot_username:user,account_id:id,webhook_secret:db.landing?.webhook_secret || config.webhook_secret};},
    webhookRegistered: async (id,user,url) => {db.landing.webhook_url=url;},
    webhookBot: async () => db.landing && {...db.landing,token:bot.token},
    getChannel: async () => db.channel,
    reserveChannel: async (id, config) => {db.channel={...config,account_id:id,status:'creating'};},
    saveChannel: async (id,key,value) => {Object.assign(db.channel,value,{status:'created'});},
    channelReady: async (id,key,invite) => {Object.assign(db.channel,{status:'ready',invite_url:invite});},
    getPost: async () => db.post,
    reservePost: async (id,key,value) => {db.post={...value,status:'sending'};},
    postReady: async (id,key,request,messageId) => {Object.assign(db.post,{status:'sent',message_id:messageId});},
  };
  const calls=[];let channels=0;
  const client = {
    checkAuthorization:async()=>true,
    createChannel:async()=>{channels++;return {id:bigInt(777),accessHash:bigInt(888)};},
    invoke:async req=>{calls.push(req);return req.className==='messages.ExportChatInvite'?{link:'https://t.me/+example'}:{id:42};},
  };
  const requests=[];
  const fetcher=async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({ok:true,result:true})};};
  const state={status:'authorized'};
  const service=createConversion({store,connected:async(s,fn)=>fn(client),save:async()=>{},env:{PUBLIC_BASE_URL:'https://bots.example.com'},fetcher});
  const route=(method,path,body={})=>service.route(method,path,'account',state,body);
  const config={customer_id:'customer-a',landing_url:'https://landing.example.com/offer?source=tg',card_text:'Hello',button_text:'Open'};
  const channel={request_key:'channel-a',bot_username:bot.username,title:'Customer channel',about:'Offers'};
  return {service,route,config,channel,db,requests,calls,get channels(){return channels;}};
}

test('landing validates URLs/text limits and preserves one secret across updates',async()=>{
  assert.throws(()=>landingConfig({customer_id:'a',landing_url:'javascript:alert(1)'}),/HTTP/);
  assert.throws(()=>landingConfig({customer_id:'a',landing_url:'https://a.test',card_image:'x',card_text:'x'.repeat(1025)}),/card_text/);
  const h=harness();const result=await h.route('PUT','bots/example_bot/landing',h.config);
  assert.equal(result.customer_id,'customer-a');assert.equal(result.webhook_secret,undefined);
  const secret=h.db.landing.webhook_secret;
  await h.route('PUT','bots/example_bot/landing',{...h.config,card_text:'Updated'});
  assert.equal(h.db.landing.webhook_secret,secret);
  await assert.rejects(h.route('PUT','bots/other_bot/landing',h.config),/不属于/);
});

test('registers per-bot HTTPS webhook and dispatches only authenticated private start',async()=>{
  const h=harness();await h.route('PUT','bots/example_bot/landing',h.config);
  const registered=await h.route('POST','bots/example_bot/webhook');
  assert.equal(registered.webhook_url,'https://bots.example.com/webhooks/123');
  assert.equal(h.requests[0].body.secret_token,h.db.landing.webhook_secret);
  await assert.rejects(h.service.handleWebhook('123','wrong',{message:{}}),/密钥/);
  await h.service.handleWebhook('123',h.db.landing.webhook_secret,{message:{chat:{id:1,type:'group'},text:'/start'}});
  assert.equal(h.requests.length,1);
  await h.service.handleWebhook('123',h.db.landing.webhook_secret,{message:{chat:{id:1,type:'private'},text:'/start campaign'}});
  assert.equal(h.requests[1].body.reply_markup.inline_keyboard[0][0].url,h.config.landing_url);
  assert.equal(h.requests[1].body.text,'Hello');
});

test('channel creation links customer, persists phases and reuses request_key',async()=>{
  const h=harness();await h.route('PUT','bots/example_bot/landing',h.config);
  const result=await h.route('POST','channels',h.channel);
  assert.equal(result.invite_url,'https://t.me/+example');assert.equal(result.access_hash,undefined);
  assert.equal(result.bot_url,'https://t.me/example_bot?start=channel');
  assert.equal(h.db.channel.customer_id,'customer-a');
  await h.route('POST','channels',h.channel);assert.equal(h.channels,1);
  await assert.rejects(h.route('POST','channels',{...h.channel,title:'Changed'}),/request_key/);
  const post=await h.route('POST','channels/channel-a/posts',{request_key:'post-a',text:'Offer'});
  assert.equal(post.status,'sent');assert.equal(post.message_id,42);
  const sent=h.calls.find(req=>req.className==='messages.SendMessage');
  assert.ok(sent.message.includes(h.config.landing_url));assert.ok(sent.message.includes('https://t.me/example_bot?start=channel'));
  await h.route('POST','channels/channel-a/posts',{request_key:'post-a',text:'Offer'});
  assert.equal(h.calls.filter(req=>req.className==='messages.SendMessage').length,1);
  await assert.rejects(h.route('POST','channels/channel-a/posts',{request_key:'post-a',text:'Different'}),/request_key/);
});

test('ambiguous remote create is never automatically repeated; created phase resumes invite',async()=>{
  const h=harness();await h.route('PUT','bots/example_bot/landing',h.config);
  h.db.channel={...h.channel,customer_id:'customer-a',status:'creating'};
  await assert.rejects(h.route('POST','channels',h.channel),/不确定/);assert.equal(h.channels,0);
  Object.assign(h.db.channel,{channel_id:'777',access_hash:'888',status:'created'});
  const result=await h.route('POST','channels',h.channel);assert.equal(result.status,'ready');assert.equal(h.channels,0);
});

test('pending send resumes with the same Telegram random_id',async()=>{
  const h=harness();await h.route('PUT','bots/example_bot/landing',h.config);await h.route('POST','channels',h.channel);
  await h.route('POST','channels/channel-a/posts',{request_key:'post-a',text:'Offer'});
  h.db.post.status='sending';const randomId=h.db.post.random_id;
  await h.route('POST','channels/channel-a/posts',{request_key:'post-a',text:'Offer'});
  assert.equal(h.calls.filter(req=>req.className==='messages.SendMessage').at(-1).randomId.toString(),randomId);
});
