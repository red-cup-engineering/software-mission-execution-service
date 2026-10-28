# software-mission-execution-service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Market-coordinated software mission cell over immutable source, durable trajectory memory, isolated tools, and customer induction.


## Durable original result custody for ASSIST and other authorized consumers — draft

The original `proposeSoftwareMission()` already computes its **RMN-derived** `executionReceipt.input` and `executionReceipt.output`. The pipeline separately records its route observation. The client has not historically persisted the full `SoftwareMissionExecutionResult` body, so an ASSIST page cannot truthfully claim to retrieve the original completed result by `missionId` merely because that result's content address was calculated.

`@red-cup-engineering/software-mission-execution-service/result-custody` now provides `createSoftwareMissionResultCustody({root,tenantRef,authorizeRead,authorizeWrite})` over the **existing original** `semantic-record-journal-service`. This is a private, explicit host-owned source vault, not a second software-mission runtime or ASSIST database. After the host has legitimately executed and received an original result, `record({principal,missionId,result})` recomputes the exact original RMN result identity, bounds JSON data to 2 MiB and appends a typed original result with an independently addressed **SEN journal receipt**; the two NI identities are not interchangeable. The original stored result remains source-reported, not a witness of customer approval, deployment or payment.

Authorized `read({principal,tenantRef,missionId})` reloads and re-verifies the source, refuses cross-tenant reads and ambiguous multiple execution results, and checks authorization before source access and again before disclosure. `attest({principal,tenantRef,missionId,result})` performs a second original journal read with semantic identity and byte-equivalent result comparison and returns an exact original-input/output attestation. These two methods are intended as the **original provider** callbacks for ASSIST's `createSoftwareMissionReader`, not as a public unauthenticated HTTP endpoint. No web request may independently choose another tenant.

**Source-only status:** the original client currently does not automatically call `record` and no installed host binds `read`/`attest`; recording must be explicitly authorized by the mission host with a private, backed-up custody root. The journal is append-only, so retention, access, lawful erasure, per-tenant limits, audit, and encrypted/private disk custody are prerequisites before collecting real customer content. A repeated identical original result is idempotently readable; a different output for the same mission **refuses** an ambiguous `missionId` selection rather than guessing the latest. Future source-owned selection by exact output receipt should be designed when a real customer needs it.

The original journal's installed version and its `record/query` interface must be verified against the mission package's currently pinned `semantic-record-journal-service` dependency and any active provider release. The [bounded execution PR #1](https://github.com/red-cup-engineering/software-mission-execution-service/pull/1) separately awaits the released command supplier. Neither a source proof nor a test mock establishes a functioning full mission production service.

Focused original tests: `node --test test/result-custody.test.mjs` (requires real original RMN identity and semantic journal dependencies). Full mission `npm run verify` must pass against the exact installed dependency closure, and original host, revocation, customer receiving and settlement remain independently unverified.

The original result-custody source now checks a bounded, own-data-only JSON snapshot before inspecting source fields or hashing; accessors, `toJSON` functions, proxies, cycles, sparse arrays and non-JSON values refuse before any journal write. A focused Node 22 pure-boundary assay passed 11 assertions, but full installed original journal/mission integration remains blocked by published dependency closure and must not be represented as verified.
