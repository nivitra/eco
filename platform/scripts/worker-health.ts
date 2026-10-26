import {pool,workerPool} from '../src/db.js';
try{const r=await pool.query("SELECT 1 FROM worker_heartbeats WHERE name='main' AND last_seen>now()-interval '90 seconds'");process.exitCode=r.rowCount?0:1;}catch{process.exitCode=1;}finally{await pool.end();if(workerPool!==pool)await workerPool.end();}
