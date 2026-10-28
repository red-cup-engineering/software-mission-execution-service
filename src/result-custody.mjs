/** Private original-source custody for software mission results.
 * This is NOT an ASSIST store, a Work queue, or an execution gateway.
 * The original semantic-record journal owns durable immutable write/read.
 * RMN execution receipt identity and SEN journal content identity stay distinct.
 */
import { createSemanticRecordJournal } from '@red-cup-engineering/semantic-record-journal-service';
import { isProxy } from 'node:util/types';
import { identifyOperation } from './semantic-content.mjs';
import { ACTOR } from './actor.mjs';

export const RESULT_CUSTODY_KIND = 'software-mission-execution.result-custody.v1';
const maxRecordBytes = 2 * 1024 * 1024;
const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const isName = x => typeof x === 'string' && x.length > 0 && x.length <= 4096
  && x.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f]/u.test(x);
const isNi = x => typeof x === 'string' && /^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/u.test(x);
const failure = reason => { throw new TypeError('original software result custody: '+reason); };
/** Snapshot finite, own JSON values without invoking user-supplied behavior.
 * JSON.stringify(originalResult) would execute getters or toJSON hooks.
 * Shared references have JSON value semantics; cycles and executable values refuse.
 */
function strictOriginalResultSnapshot(value) {
  let nodes = 0;
  const active = new WeakSet();
  const copy = (item, depth) => {
    if (++nodes > 32768 || depth > 64)
      failure('source result exceeds admitted custody structure');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') {
      if (!item.isWellFormed()) failure('nonserializable source result');
      return item;
    }
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || isProxy(item))
      failure('nonserializable source result');
    if (active.has(item)) failure('nonserializable source result');
    const proto = Object.getPrototypeOf(item);
    if (Array.isArray(item) ? proto !== Array.prototype
        : proto !== Object.prototype && proto !== null)
      failure('nonserializable source result');
    active.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string' || !key.isWellFormed() ||
        !('value' in descriptors[key])))
      failure('nonserializable source result');
    let result;
    if (Array.isArray(item)) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1 ||
          keys.some(key => key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key)))
        failure('nonserializable source result');
      result = [];
      for (let index = 0; index < length; index++) {
        if (!Object.hasOwn(descriptors, String(index)))
          failure('nonserializable source result');
        result.push(copy(descriptors[String(index)].value, depth + 1));
      }
    } else {
      result = Object.create(null);
      for (const key of keys) result[key] = copy(descriptors[key].value, depth + 1);
    }
    active.delete(item);
    return result;
  };
  const json = JSON.stringify(copy(value, 0));
  if (typeof json !== 'string') failure('nonserializable source result');
  if (Buffer.byteLength(json, 'utf8') > maxRecordBytes)
    failure('source result exceeds admitted custody size');
  return JSON.parse(json);
}

const categoryFor = (tenantRef, missionId) =>
  'software-mission-execution.result:'+JSON.stringify([tenantRef,missionId]);

/** Validate and normalize the *exact* result that the existing
 * proposeSoftwareMission() source returned. Do not infer success/acceptance
 * from an NI-like string: recompute its original RMN response identity.
 * This is deliberately only usable for a JSON-safe, bounded result. */
export function admitOriginalSoftwareMissionResult(missionId, value) {
  if (!isName(missionId)) failure('source identity or outcome mismatch');
  const admitted = strictOriginalResultSnapshot(value);
  if (!isObject(admitted)
    || admitted.executionProvider !== ACTOR
    || !isObject(admitted.executionReceipt)
    || !isNi(admitted.executionReceipt.input) || !isNi(admitted.executionReceipt.output)
    || !isObject(admitted.route) || admitted.route.id !== missionId
    || !isObject(admitted.outcome)
    || typeof admitted.route.finalVerified !== 'boolean'
    || typeof admitted.route.finalAnswered !== 'boolean'
    || admitted.route.finalVerified !== (admitted.outcome.verified === true)
    || admitted.route.finalAnswered !== (admitted.outcome.answered === true)
    || typeof admitted.route.finishedAt !== 'string'
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(admitted.route.finishedAt)
    || Number.isNaN(Date.parse(admitted.route.finishedAt))) {
    failure('source identity or outcome mismatch');
  }
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
