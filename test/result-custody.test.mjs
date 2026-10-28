import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {identifyOperation} from '../src/semantic-content.mjs';
import {ACTOR} from '../src/actor.mjs';
import {admitOriginalSoftwareMissionResult,createSoftwareMissionResultCustody} from '../src/result-custody.mjs';

const ni = c => 'ni:///sha-256;' + c.repeat(43);
const missionId='urn:test:software-mission:privately-custodied';
const principal=Object.freeze({subject:'actor:customer-one'});
const source=(verified=true,suffix='')=>{
  const value={
    outcome:{verified,answered:false},
    route:{type:'SoftwareMissionRouteObservation',id:missionId,
      routePolicy:'enterprise-memory-pulse-only',finishedAt:'2026-10-27T12:00:00.000Z',
      finalVerified:verified,finalAnswered:false,phaseCount:1,
      inferenceAttempts:1,usefulCompletions:verified?1:0,directInteractiveModelCalls:0,
      continuation:{state:verified?'awaiting-customer-induction':'durable-demand-open'},
      note:suffix,
    },
  };
  const request=ni('A');
  const output=identifyOperation({type:'SoftwareMissionExecutionResult',provider:ACTOR,
    request,mission:missionId,result:value}).id;
  return {...value,executionProvider:ACTOR,executionReceipt:{input:request,output}};
};
const withRoot=async run=>{
  const root=mkdtempSync(join(tmpdir(),'software-original-custody-'));
  try{return await run(root)}finally{rmSync(root,{recursive:true,force:true})}
};
const opened=(root,tenantRef='tenant-one',more={})=>createSoftwareMissionResultCustody({
  root,tenantRef,
  authorizeWrite:async()=>true,authorizeRead:async()=>true,...more,
});

test('source-owned journal survives reopening with original RMN identity and distinct SEN receipt',async()=>withRoot(async root=>{
  const first=opened(root);
  const input=source();
  const receipt=await first.record({principal,missionId,result:input});
  assert.match(receipt.journalId,/^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/);
  assert.equal(receipt.executionResult,input.executionReceipt.output);
  assert.equal(receipt.executionRequest,input.executionReceipt.input);
  assert.equal(receipt.independentCustomerAcceptance,'not-assayed-here');
  const second=opened(root);
  assert.deepEqual(await second.read({principal,missionId}),input);
  const verified=await second.attest({principal,tenantRef:'tenant-one',missionId,result:input});
  assert.equal(verified.contentVerified,true);
  assert.equal(verified.input,input.executionReceipt.input);
  assert.equal(verified.output,input.executionReceipt.output);
  assert.equal(verified.journalId,receipt.journalId);
}));

test('writer refuses source-claimed output address unrelated to canonical original response',async()=>withRoot(async root=>{
  const c=opened(root),forged=source();
  forged.executionReceipt.output=ni('Z');
  await assert.rejects(c.record({principal,missionId,result:forged}),
    /execution result does not match original RMN content address/);
  await assert.rejects(c.read({principal,missionId}),/no original result/);
}));

test('result content cannot be changed after address admission without an independent new original receipt',async()=>withRoot(async root=>{
  const c=opened(root),input=source();
  await c.record({principal,missionId,result:input});
  const tampered={...input,outcome:{verified:false,answered:false}};
  await assert.rejects(c.attest({principal,tenantRef:'tenant-one',missionId,result:tampered}),
    /source identity or outcome mismatch|execution result does not match/);
  assert.equal((await c.read({principal,missionId})).outcome.verified,true);
}));

test('wrong tenant cannot read another tenant result even with matching mission identity',async()=>withRoot(async root=>{
  await opened(root,'tenant-one').record({principal,missionId,result:source()});
  await assert.rejects(opened(root,'tenant-two').read({principal,missionId}),
    /no original result/);
  await assert.rejects(opened(root,'tenant-one').read({principal,tenantRef:'tenant-two',missionId}),
    /cross-tenant/);
  await assert.rejects(opened(root,'tenant-one').attest({
    principal,tenantRef:'tenant-two',missionId,result:source(),
  }),/cross-tenant/);
}));

test('source-only authorizer runs before read and again before the result escapes',async()=>withRoot(async root=>{
  await opened(root).record({principal,missionId,result:source()});
  let reads=0;
  const c=opened(root,'tenant-one',{authorizeRead:async()=>++reads===1});
  await assert.rejects(c.read({principal,missionId}),/not authorized/);
  assert.equal(reads,2);
}));

test('writer and reader both refuse absent authenticated authority',async()=>withRoot(async root=>{
  const denied=opened(root,'tenant-one',{
    authorizeRead:async()=>false,authorizeWrite:async()=>false,
  });
  await assert.rejects(denied.record({principal,missionId,result:source()}),/not authorized/);
  await assert.rejects(denied.read({principal,missionId}),/not authorized/);
  assert.throws(()=>createSoftwareMissionResultCustody({root,tenantRef:'tenant-one'}),/host-bound/);
}));

test('multiple distinct original executions of one mission are ambiguous, never silently newest',async()=>withRoot(async root=>{
  const c=opened(root);
  await c.record({principal,missionId,result:source(true,'first')});
  await c.record({principal,missionId,result:source(false,'second')});
  await assert.rejects(c.read({principal,missionId}),/ambiguous original results/);
}));

test('repeated exact original result remains idempotently readable',async()=>withRoot(async root=>{
  const c=opened(root),value=source();
  const a=await c.record({principal,missionId,result:value});
  const b=await c.record({principal,missionId,result:value});
  assert.equal(a.journalId,b.journalId);
  assert.deepEqual(await c.read({principal,missionId}),value);
}));

test('a large or cyclic source cannot enter private persistent custody by accident',async()=>withRoot(async root=>{
  const c=opened(root);
  const tooLarge=source();
  tooLarge.secret='x'.repeat(2*1024*1024);
  await assert.rejects(c.record({principal,missionId,result:tooLarge}),/exceeds admitted custody size/);
  const cyclic=source();cyclic.loop=cyclic;
  await assert.rejects(c.record({principal,missionId,result:cyclic}),/nonserializable source result/);
}));

test('body fields are not secretly reinterpreted as customer acceptance or payment',async()=>withRoot(async root=>{
  const c=opened(root),v=source(false);
  const receipt=await c.record({principal,missionId,result:v});
  assert.equal(receipt.independentCustomerAcceptance,'not-assayed-here');
  const checked=await c.read({principal,missionId});
  assert.equal(checked.outcome.verified,false);
  assert.equal(checked.executionReceipt.output,v.executionReceipt.output);
}));

test('custody never invokes executable getters, toJSON or Proxy traps during result admission',async()=>withRoot(async root=>{
  const c=opened(root);
  let invoked=0;
  const accessor=source();
  Object.defineProperty(accessor.route,'supplier',{enumerable:true,
    get(){invoked++;throw new Error('a hostile getter ran');}});
  await assert.rejects(c.record({principal,missionId,result:accessor}),/nonserializable source result/);
  const conversion=source();
  conversion.toJSON=()=>{invoked++;throw new Error('supplier toJSON ran');};
  await assert.rejects(c.record({principal,missionId,result:conversion}),/nonserializable source result/);
  const proxy=source();
  proxy.untrusted=new Proxy({text:'not observable'},{ownKeys(){invoked++;throw new Error('proxy trap ran');}});
  await assert.rejects(c.record({principal,missionId,result:proxy}),/nonserializable source result/);
  assert.equal(invoked,0,'result identity admission may never execute supplier object behavior');
  await assert.rejects(c.read({principal,missionId}),/no original result/);
}));

test('custody refuses lossy or ambiguous JSON values before persisting original evidence',async()=>withRoot(async root=>{
  const c=opened(root);
  for(const nonJson of [{x:NaN},{x:Infinity},{x:undefined},{x:2n},{x:new Date('2026-10-27')}]) {
    await assert.rejects(c.record({principal,missionId,result:{...source(),nonJson}}),
      /nonserializable source result/);
  }
  const sparse=[];sparse[1]=1;
  await assert.rejects(c.record({principal,missionId,result:{...source(),sparse}}),
    /nonserializable source result/);
  const hidden={...source()};hidden[Symbol('source')]=true;
  await assert.rejects(c.record({principal,missionId,result:hidden}),
    /nonserializable source result/);
  const malformed={...source(),broken:'\uD800'};
  await assert.rejects(c.record({principal,missionId,result:malformed}),
    /nonserializable source result/);
}));
