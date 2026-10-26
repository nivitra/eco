import {serve} from '@hono/node-server';
import {app} from './app.js';
import {config} from './config.js';
import {pool,workerPool} from './db.js';
import {authPool} from './auth.js';
const server=serve({fetch:app.fetch,port:config.port,hostname:process.env.HOST||'0.0.0.0'});
console.log(JSON.stringify({event:'server_started',port:config.port}));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server.close(async()=>{await Promise.all([pool.end(),authPool.end(),...(workerPool!==pool?[workerPool.end()]:[])]);process.exit(0);});setTimeout(()=>process.exit(1),20000).unref();});
