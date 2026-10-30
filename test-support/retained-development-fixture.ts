// Disposable existing retained-app/migration format shared with the Drafted pair.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RetainedDevelopmentTask } from "../apps/server/services/tasks/retained-development.ts";
const hash=(value:unknown)=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export async function retainedDevelopmentFixture(overrides: Partial<{taskId:string;primarySessionId:string;worktreePath:string;toolingRevision:string}> = {}){
 const root=await mkdtemp(path.join(await realpath(tmpdir()),'retained-selection-'));
 const identity={taskId:'task',primarySessionId:'primary',worktreePath:path.join(root,'product'),toolingRevision:'a'.repeat(40),purpose:'development',...overrides};
 const task:RetainedDevelopmentTask & {ownerPaused:boolean;phase:string}={id:identity.taskId,...identity,resources:[],ownerPaused:false,phase:'waiting'};
 const file=async(name:string,value:unknown)=>{const file=path.join(root,name);await mkdir(path.dirname(file),{recursive:true,mode:0o700});await writeFile(file,JSON.stringify(value),{mode:0o600});return {file,sha256:hash(value)};};
 const record=(key:string,kind:string,externalId:string,metadata:any)=>{const r={id:`id-${key}`,key,kind,purpose:'development',state:'ready',externalId,metadata};task.resources.push(r);return r;};
 const compose=record('compose','docker-compose',path.join(root,'compose.json'),{project:'original-project'});
 const sourceMeta=(service:string)=>({manifest:compose.externalId,service,image:`sha256:${'f'.repeat(64)}`});
 const mysql=record('mysql','docker-container','a'.repeat(64),sourceMeta('mysql'));
 const spatial=record('spatial','docker-container','b'.repeat(64),sourceMeta('spatial'));
 const old=record('old-workspace','docker-container','c'.repeat(64),sourceMeta('workspace'));
 record('mysql-volume','docker-volume','mysql-data',{manifest:compose.externalId});
 const source=await file('source.json',{...identity,version:1,composeKey:compose.key,composeSha256:'a'.repeat(64),containerKey:mysql.key,volumeKey:'mysql-volume'});
 const targetConfig=await file('target.json',{...identity,key:'mysql-target',sourceConfigurationFile:source.file,sourceConfigurationSha256:source.sha256});
 const target=record('mysql-target','planetscale-branch','remote-mysql',{version:1,configurationFile:targetConfig.file,configurationSha256:targetConfig.sha256,sourceDigest:'b'.repeat(64),provider:{id:'remote-mysql'}});
 const cutover=await file('cutover.json',{project:'original-project',branchId:'remote-branch',state:'migrated',completedAt:new Date().toISOString(),containers:[{id:old.externalId,service:'workspace'}]});
 const mapping=await file('mapping.json',[{...identity,worktree:identity.worktreePath,project:'original-project',sourceId:spatial.externalId,composeFiles:[compose.externalId],branchId:'remote-branch',copy:[{database:'spatial'},{database:'terrain'}]}]);
 const provenance={receiptFile:cutover.file,receiptSha256:cutover.sha256,mappingFile:mapping.file,mappingSha256:mapping.sha256};
 const endpoints:any={mysql:{file:path.join(root,'secret-mysql.json'),sha256:'d'.repeat(64),binding:{resourceKey:target.key,provider:'planetscale',resourceId:target.externalId,recipeFile:targetConfig.file,recipeSha256:targetConfig.sha256}}};
 for(const name of ['spatial','terrain']){const r=record(`${name}-target`,'neon-branch-database',`remote-branch/${name}`,{...provenance,cutoverReceipt:cutover.file,sourceResourceId:spatial.id,composeResourceId:compose.id,sourceProject:'original-project',reconciliationVersion:1});endpoints[name]={file:path.join(root,`secret-${name}.json`),sha256:'d'.repeat(64),binding:{resourceKey:r.key,provider:'neon',resourceId:r.externalId}};}
 const config={...identity,version:1,key:'app',directory:path.join(root,'app'),transferConfigurationFile:path.join(root,'transfer/configuration.json'),source,sourceDigest:'b'.repeat(64),workspace:{resourceKey:old.key,originalId:old.externalId,id:'d'.repeat(64),createdAt:'original-created',image:sourceMeta('').image},endpoints};
 const pin=await file('configuration.json',config);
 const retained={version:1,configurationFile:pin.file,configurationSha256:pin.sha256,receiptFile:path.join(config.directory,'app.json'),operation:crypto.randomUUID(),launchSha256:'c'.repeat(64),containerIdentityDigest:'e'.repeat(64),dataResourceKeys:Object.values(endpoints).map((v:any)=>v.binding.resourceKey)};
 const app=record('app','docker-container','e'.repeat(64),{image:config.workspace.image,retainedStudio:retained});
 const boundary={version:1,taskId:task.id,purpose:'development',sourceIds:[mysql.externalId],targetIds:Object.values(endpoints).map((v:any)=>v.binding.resourceId),resources:task.resources.filter(r=>![old.key,spatial.key].includes(r.key)).map(({key,kind,purpose,externalId})=>({key,kind,purpose,externalId}))};
 await file('app/app.json',{version:1,configurationSha256:pin.sha256,operation:retained.operation,launchSha256:retained.launchSha256,container:{id:app.externalId,createdAt:'app-created',identityDigest:retained.containerIdentityDigest},boundary});
 const stores=Object.entries(endpoints).map(([name,e]:[string,any])=>({name,kind:'sql',mode:name==='mysql'?'copy':'reuse-target',...(name==='mysql'?{sourceId:mysql.externalId,sourceFile:source.file,sourceSha256:source.sha256,sourceBinding:{resourceKey:mysql.key,resourceId:mysql.externalId,provider:'docker'},sourcePreparation:'stopped-mysql'}:{provenance}),targetId:e.binding.resourceId,targetFile:e.file,targetSha256:e.sha256,targetBinding:e.binding}));
 const transfer={version:1,boundary,stores};await file('transfer/configuration.json',transfer);await file('transfer/transfer.json',{version:1,phase:'complete',configHash:hash(transfer),completedAt:new Date().toISOString()});
 const actual=new Map([mysql,spatial,{...old,externalId:config.workspace.id},app].map(r=>[r.externalId,{id:r.externalId,image:config.workspace.image,createdAt:r.key==='app'?'app-created':'original-created',running:r.key==='app',labels:{'ai.drafted.task':task.id,'ai.drafted.purpose':'development','com.docker.compose.project':'original-project','com.docker.compose.service':r.key==='old-workspace'?'workspace':r.key}}]));
 const effects:string[]=[];
 const docker={inspect:async(_kind:string,id:string)=>actual.get(id)??null,stop:async(id:string)=>{effects.push(`stop:${id}`);actual.get(id)!.running=false;},start:async(id:string)=>{effects.push(`start:${id}`);actual.get(id)!.running=true;},remove:async()=>{throw Error('no deletion');}};
 const registry={task:async()=>structuredClone(task),resource:async(value:any)=>{Object.assign(task.resources.find(r=>r.key===value.key)!,value);}};
 return {root,task,registry,config,app,mysql,spatial,old,retained,actual,docker,effects,file};
}
