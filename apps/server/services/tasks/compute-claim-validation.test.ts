import { beforeEach, afterEach, expect, test } from 'bun:test';
import {createTestDatabase,type TestDatabase} from '../../../../test-support/db.ts';
import {ComputePolicy} from '../../../../lib/compute-policy.ts';
import {claimCompute,requestCompute,offerNextCompute,confirmComputeDelivery,reconcileComputeOffers,declineCompute,COMPUTE_VALIDATION_MS} from './compute-admission.ts';
import {assertComputeStartIntent} from './development-intent.ts';
let db:TestDatabase;let offer:any;let now:Date;
const request={key:'development',purpose:'development' as const,revision:'a'.repeat(40),recipeDigest:'b'.repeat(64)};
const base=()=>({prisma:db.prisma,machineId:'host',policy:ComputePolicy.parse({enabled:true,slots:1}),now});
const input=()=>({...base(),taskId:'task',offerId:offer.id,request});
beforeEach(async()=>{
 db=await createTestDatabase();now=new Date('2030-01-01T00:00:00Z');
 await db.prisma.runtimeSession.create({data:{id:'primary',scopeKey:'task',agentCommand:'codex',repositoryId:'repo',machineId:'host',role:'primary',cwd:'/fixture/task',status:'idle'}});
 await db.prisma.remoteTask.create({data:{id:'task',requestKey:'task',repositoryId:'repo',machineId:'host',branchName:'codex/task',worktreePath:'/fixture/task',toolingRoot:'/fixture/tooling',toolingRevision:'c'.repeat(40),primarySessionId:'primary',phase:'working'}});
 await requestCompute({...base(),taskId:'task',request});offer=(await offerNextCompute(base()))!;
 await db.prisma.runtimeInstruction.update({where:{id:offer.instructionId},data:{state:'dispatching',executionRequestId:offer.instructionId}});
 await db.prisma.runtimeLifecycleEvent.create({data:{id:'started',runtimeSessionId:'primary',requestId:offer.instructionId,phase:'started',occurredAt:now}});
 offer=await confirmComputeDelivery({...base(),sessionId:'primary',requestId:offer.instructionId});now=new Date(now.getTime()+26000);
});
afterEach(async()=>{await db.cleanup()});
const saved=()=>db.prisma.computeOffer.findUniqueOrThrow({where:{id:offer.id}});
test('timely validation survives original expiry without extending original deadline or granting early start',async()=>{
 const deadline=offer.expiresAt;
 const result=await claimCompute(input(),async()=>{
  expect((await saved()).state).toBe('validating');expect((await saved()).claimedAt).toBeNull();
  await expect(assertComputeStartIntent(db.prisma,'task',offer.environmentId,offer.id)).rejects.toThrow();
  now.setTime(now.getTime()+35000);await reconcileComputeOffers(base());
  expect((await saved()).state).toBe('validating');expect(await db.prisma.computeSlot.count({where:{allocationId:offer.id}})).toBe(1);
 });
 expect(result.offer.state).toBe('claimed');expect(result.offer.expiresAt).toEqual(deadline);expect(result.offer.validationToken).toBeNull();
});
test('late initial claim never validates',async()=>{now=new Date(offer.expiresAt.getTime());let reads=0;await expect(claimCompute(input(),async()=>{reads++})).rejects.toThrow('expired');expect(reads).toBe(0)});
test('foreign recipe never validates',async()=>{let reads=0;await expect(claimCompute({...input(),request:{...request,recipeDigest:'d'.repeat(64)}},async()=>{reads++})).rejects.toThrow('exact environment');expect(reads).toBe(0)});
for(const action of ['pause','decline','timeout','capacity','observer failure'] as const)test(`validation refuses ${action} and cannot start`,async()=>{
 await expect(claimCompute(input(),async()=>{
  if(action==='pause')await db.prisma.remoteTask.update({where:{id:'task'},data:{ownerPaused:true}});
  if(action==='decline')await declineCompute({...base(),taskId:'task',offerId:offer.id});
  if(action==='timeout'){now.setTime(now.getTime()+COMPUTE_VALIDATION_MS);await reconcileComputeOffers(base())}
  if(action==='capacity')await db.prisma.remoteTaskResource.create({data:{taskId:'task',key:'unknown',kind:'docker-container',purpose:'development',externalId:'d'.repeat(64),state:'ready'}});
  if(action==='observer failure')throw Error('inventory unavailable');
 })).rejects.toThrow();
 expect((await saved()).claimedAt).toBeNull();if(action==='pause')await reconcileComputeOffers(base());expect(await db.prisma.computeSlot.count({where:{allocationId:offer.id}})).toBe(['capacity','observer failure'].includes(action)?1:0);
});
test('persisted validation resumes after connection restart with original deadline and token',async()=>{
 await db.prisma.computeOffer.update({where:{id:offer.id},data:{state:'validating',validationToken:'original-validation',validationExpiresAt:new Date(now.getTime()+COMPUTE_VALIDATION_MS)}});
 await db.prisma.$disconnect();now.setTime(now.getTime()+40000);
 expect((await claimCompute(input(),async()=>{})).offer.state).toBe('claimed');
});
test('lost success reply reuses completed allocation without another observer read',async()=>{
 await claimCompute(input(),async()=>{});let reads=0;const result=await claimCompute(input(),async()=>{reads++});expect(result.resumed).toBe(true);expect(reads).toBe(0);
});
test('concurrent duplicate claims share one validation and one allocation',async()=>{
 let entered!:()=>void,release!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);let reads=0;
 const refresh=async()=>{reads++;entered();await gate};const first=claimCompute(input(),refresh);await ready;
 const second=claimCompute(input(),refresh);await Bun.sleep(20);release();const results=await Promise.all([first,second]);expect(reads).toBe(1);expect(results[0].offer.id).toBe(results[1].offer.id);expect(await db.prisma.computeSlot.count({where:{allocationId:offer.id}})).toBe(1);
});
