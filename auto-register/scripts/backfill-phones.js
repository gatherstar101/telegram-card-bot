import {createDatabase} from '../api/database.js';
import {credentials} from '../api/security.js';
import {backfillPhoneIndex} from '../api/phone-index.js';

// Explicit offline migration also accepts old plaintext phone fields.
const crypt=credentials(process.env,{allowPlaintext:true});
const database=await createDatabase({...process.env,DB_AUTO_CREATE_DATABASE:'false'});
try{
  const result=await backfillPhoneIndex(database.pool,crypt);
  console.log(JSON.stringify({operation:'phone_index_backfill',...result}));
}finally{await database.pool.end();}
