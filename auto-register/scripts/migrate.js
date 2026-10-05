import {createDatabase} from '../api/database.js';
import {initializeSchema} from '../api/migrations.js';
const env={...process.env,DB_SCHEMA_INIT:'true'};
const database=await createDatabase(env);
try{await initializeSchema(database,env);console.log('数据库结构初始化完成');}finally{await database.pool.end();}
