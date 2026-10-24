# software-mission-execution-service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Market-coordinated software mission cell over immutable source, durable trajectory memory, isolated tools, and customer induction.

## Source-owned customer Work execution budgets (pending supplier receiving)

The original mission engine uses one
[`@red-cup-engineering/sandbox-command-execution-service`](https://github.com/red-cup-engineering/sandbox-command-execution-service)
at source verification, post-edit checks, acceptance and named commands. The
upstream [bounded execution PR #1](https://github.com/red-cup-engineering/sandbox-command-execution-service/pull/1)
repairs actual infinite output/no deadline, wrong-cwd authority, and
POSIX orphaned children of timed-out workers, and receives 16/16 tests on
real native Node 22 with exact source Git hashes.
This mission source change **does not duplicate or replace that supplier**.

A Work principal may now supply optional
`commandLimits: {timeoutMs,maxOutputBytes}` on its original `runMission`
input. The exact policy is normalized by the supplier's
`admitCommandLimits` (not a new local policy calculator) before Work
initialization, included in the existing source-derived mission identity
when explicitly selected, and passed to original baseline verification,
acceptance verification, deterministic replay, resumed process nodes,
post-edit checks and separately admitted named commands. Missing policy
retains the finite supplier defaults. The accepted Work original directory
cannot be displaced by `opts.cwd`.

The existing actor `checkObservation` and named-command readouts retain
`failureKind` (deadline/output-limit/spawn/signaled/cancelled/nonzero-exit
or unknown for an old/incomplete readout), measured `observedWallMs`,
`processGroupCleanup` (the actual POSIX cleanup-signal attempt, otherwise
unknown for an old provider), and the effective numeric `limits` alongside
`passed` and `output`.
A passing syntax/test command remains merely verification of one process
attempt. A monetary claim requires **separate** admitted execution
capacity, original buyer rights/Work, output hashes, independent receiving,
customer acceptance, provider costs, settlement and corporate revenue
recognition. Local wall time is not CPU occupancy, independently verified
resource metering or a billable contract by itself.

**Hard downstream hold:** this repo's original pinned manifest still
selects `sandbox-command-execution-service@1.0.0`, which does *not*
export the new `admitCommandLimits`. Do NOT merge/publish this dependent
source until original Engineering publishes and selects an exact edition
of [supplier PR #1](https://github.com/red-cup-engineering/sandbox-command-execution-service/pull/1),
updates the pinned dependency through its actual package-release owner,
runs the full original mission native tests, exercises an isolated
customer Work result, and verifies coherent recorded counters across
baseline, edit and acceptance. The 2 new `agent-tools` tests exercise
real hanging/output-flooding child cases but are **authored, not native
dependency-backed executed** here. Exact changed agent/source/test files
have been parsed or source-extracted and mock exercised; that is not
evidence that the installed marketplace/mission host has received them.
