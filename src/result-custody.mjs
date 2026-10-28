/** Private original-source custody for software mission results.
 * This is NOT an ASSIST store, a Work queue, or an execution gateway.
 * The original semantic-record journal owns durable immutable write/read.
 * RMN execution receipt identity and SEN journal content identity stay distinct.
 */
import { createSemanticRecordJournal } from '@red-cup-engineering/semantic-record-journal-service';
import { identifyOperation } from './semantic-content.mjs';
import { ACTOR } from './actor.mjs';

export const RESULT_CUSTODY_KIND = 'software-mission-execution.result-custody.v1';
const maxRecordBytes = 2 * 1024 * 1024;
const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const isName = x => typeof x === 'string' && x.length > 0 && x.length <= 4096
  && x.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f]/u.test(x);
const isNi = x => typeof x === 'string' && /^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/u.test(x);
const failure = reason => { throw new TypeError('original software result custody: '+reason); };
const categoryFor = (tenantRef, missionId) =>
  'software-mission-execution.result:'+JSON.stringify([tenantRef,missionId]);

/** Validate and normalize the *exact* result that the existing
 * proposeSoftwareMission() source returned. Do not infer success/acceptance
 * from an NI-like string: recompute its original RMN response identity.
 * This is deliberately only usable for a JSON-safe, bounded result. */
export function admitOriginalSoftwareMissionResult(missionId, value) {
  if (!isName(missionId) || !isObject(value)
    || value.executionProvider !== ACTOR
    || !isObject(value.executionReceipt)
    || !isNi(value.executionReceipt.input) || !isNi(value.executionReceipt.output)
    || !isObject(value.route) || value.route.id !== missionId
    || !isObject(value.outcome)
    || typeof value.route.finalVerified !== 'boolean'
    || typeof value.route.finalAnswered !== 'boolean'
    || value.route.finalVerified !== (value.outcome.verified === true)
    || value.route.finalAnswered !== (value.outcome.answered === true)
    || typeof value.route.finishedAt !== 'string'
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value.route.finishedAt)
    || Number.isNaN(Date.parse(value.route.finishedAt))) {
    failure('source identity or outcome mismatch');
  }
  let json;
  try { json=JSON.stringify(value); } catch { failure('nonserializable source result'); }
  if (typeof json !== 'string' || Buffer.byteLength(json,'utf8') > maxRecordBytes)
    failure('source result exceeds admitted custody size');
  const admitted = JSON.parse(json);
  const {executionProvider,executionReceipt,...execution} = admitted;
  const response={
    type:'SoftwareMissionExecutionResult',provider:ACTOR,
    request:executionReceipt.input,mission:missionId,result:execution,
  };
  if (identifyOperation(response).id !== executionReceipt.output)
    failure('execution result does not match original RMN content address');
  return Object.freeze(admitted);
}

/** The host supplies a *private*, separately controlled custody root and
 * current provider-authoritative read/write policy. Neither a prompt nor a
 * request body may name another tenant. A result is persisted only after
 * authenticated, explicit original-result custody admission. */
export function createSoftwareMissionResultCustody({
  root,tenantRef,authorizeRead,authorizeWrite,
}={}) {
  if (!isName(root) || !isName(tenantRef) || typeof authorizeRead !== 'function'
    || typeof authorizeWrite !== 'function') failure('host-bound root and authority required');
  const journal=createSemanticRecordJournal({root,objectKind:RESULT_CUSTODY_KIND});
  const authorize=async (operation,principal,missionId)=>{
    if (!isObject(principal) || !isName(missionId)) failure('authenticated principal and mission required');
    const method=operation==='write'?authorizeWrite:authorizeRead;
    let allowed;
    try { allowed=await method({principal,tenantRef,missionId,operation:'software-result-'+operation}); }
    catch { failure('authorization unavailable'); }
    if (allowed !== true) failure('not authorized');
  };
  const reading=(missionId)=>{
    let rows;
    try { rows=journal.query({category:categoryFor(tenantRef,missionId)}); }
    catch { failure('original journal unavailable'); }
    if (!Array.isArray(rows) || rows.length > 100) failure('original journal response invalid');
    const distinct=new Map();
    for (const row of rows) {
      if (row.objectKind !== RESULT_CUSTODY_KIND || !isNi(row.id)
        || !isObject(row.record) || row.record.kind !== RESULT_CUSTODY_KIND
        || row.record.tenantRef !== tenantRef || row.record.missionId !== missionId) {
        failure('journal source mismatch');
      }
      const evidence=admitOriginalSoftwareMissionResult(missionId,row.record.result);
      distinct.set(row.id,evidence);
    }
    if (distinct.size === 0) failure('no original result in this custody scope');
    if (distinct.size > 1) failure('ambiguous original results for mission');
    return {rowId:[...distinct.keys()][0],result:[...distinct.values()][0]};
  };
  return Object.freeze({
    async record({principal,missionId,result}={}) {
      await authorize('write',principal,missionId);
      const admitted=admitOriginalSoftwareMissionResult(missionId,result);
      // Appending a receipt cannot establish the mission's independent customer
      // acceptance, and does not transform an original RMN NI into a SEN NI.
      const body={kind:RESULT_CUSTODY_KIND,tenantRef,missionId,result:admitted};
      const observed=admitted.route.finishedAt;
      const written=journal.record({
        category:categoryFor(tenantRef,missionId),recordedAt:observed,record:body,
        charge:{support:true,refutation:false},
        relation:{subject:missionId,predicate:'recorded-execution-result',
          object:admitted.executionReceipt.output},
      });
      if (!isNi(written?.id)) failure('original journal did not return an address');
      return Object.freeze({kind:'software-mission-execution.result-custody-receipt.v1',
        journalId:written.id,
        executionRequest:admitted.executionReceipt.input,
        executionResult:admitted.executionReceipt.output,
        independentCustomerAcceptance:'not-assayed-here'});
    },
    async read({principal,tenantRef:requestedTenant,missionId,...other}={}) {
      if (requestedTenant!==undefined && requestedTenant!==tenantRef || Object.keys(other).length)
        failure('cross-tenant or unsupported read selection');
      await authorize('read',principal,missionId);
      const source=reading(missionId);
      await authorize('read',principal,missionId);
      return source.result;
    },
    /** Requery the original journal and verify its original RMN result address
     * for ASSIST's independent read/attestation callback. */
    async attest({principal,tenantRef:requestedTenant,missionId,result,...other}={}) {
      if (requestedTenant!==tenantRef || Object.keys(other).length)
        failure('cross-tenant or unsupported attestation');
      await authorize('read',principal,missionId);
      const wanted=admitOriginalSoftwareMissionResult(missionId,result);
      const source=reading(missionId);
      if (source.result.executionReceipt.output !== wanted.executionReceipt.output
        || source.result.executionReceipt.input !== wanted.executionReceipt.input
        || JSON.stringify(source.result)!==JSON.stringify(wanted)) {
        failure('result not present under original private custody');
      }
      await authorize('read',principal,missionId);
      return Object.freeze({contentVerified:true,input:wanted.executionReceipt.input,
        output:wanted.executionReceipt.output,
        journalId:source.rowId});
    },
  });
}
