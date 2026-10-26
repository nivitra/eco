import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
const run=promisify(execFile);

// Exercise the real backup script with a fake Docker executable. No daemon or
// database is used. The failure cases specifically exercise the EXIT trap.
for(const scenario of ['success','database-failure','restart-failure','no-worker'] as const){
 test(`backup resumes exact existing worker only: ${scenario}`,async t=>{
  const root=await mkdtemp(join(tmpdir(),'kulture-backup-resume-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'ops'));await mkdir(join(root,'bin'));
  await writeFile(join(root,'ops','backup.sh'),await readFile(new URL('../ops/backup.sh',import.meta.url)));
  const worker='a'.repeat(64),secondWorker='b'.repeat(64),calls=join(root,'calls.jsonl');
  await writeFile(join(root,'bin','docker'),`#!${process.execPath}
const fs=require('node:fs');const a=process.argv.slice(2);
fs.appendFileSync(process.env.CALLS,JSON.stringify(a)+'\\n');
if(a.join(' ')==='compose ps --status running -q worker'){
 if(process.env.SCENARIO!=='no-worker')process.stdout.write(process.env.WORKERS+'\\n');
}else if(a[0]==='compose'&&a[1]==='exec'){
 if(process.env.SCENARIO==='database-failure')process.exit(17);
 process.stdout.write('test-only database snapshot');
}else if(a[0]==='compose'&&a[1]==='run'){
 process.stdout.write(a.includes('ops')?'{}':'test-only media archive');
}else if(a[0]==='container'&&a[1]==='start'){
 if(process.env.SCENARIO==='restart-failure')process.exit(7);
}else if(a.join(' ')==='compose stop worker'){
}else{console.error('Unexpected Docker action',a);process.exit(99);}
`);
  await chmod(join(root,'bin','docker'),0o755);
  let exit=0;
  try{await run('bash',[join(root,'ops','backup.sh')],{env:{...process.env,PATH:join(root,'bin')+':'+process.env.PATH,CALLS:calls,SCENARIO:scenario,WORKERS:worker+'\n'+secondWorker,BACKUP_AGE_RECIPIENT:''}});}
  catch(error){exit=Number((error as {code?:number}).code);}
  assert.equal(exit,scenario==='database-failure'?17:scenario==='restart-failure'?1:0);
  const actions=(await readFile(calls,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as string[]);
  assert(!actions.some(a=>a[0]==='compose'&&['start','up'].includes(a[1])),'must not traverse migrate or seed dependencies');
  const resumes=actions.filter(a=>a[0]==='container'&&a[1]==='start');
  assert.deepEqual(resumes,scenario==='no-worker'?[]:[['container','start',worker,secondWorker]]);
  assert.equal(actions.filter(a=>a.join(' ')==='compose stop worker').length,scenario==='no-worker'?0:1);
 });
}
