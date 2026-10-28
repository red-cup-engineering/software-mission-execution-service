# software-mission-execution-service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Market-coordinated software mission cell over immutable source, durable trajectory memory, isolated tools, and customer induction.

## Finite original agent source observations

The incumbent `src/agent-tools.mjs` now bounds source enumeration to 4,096
regular files, 4,096 directories and **4,096 entries per directory**, with a
maximum depth of 64. Its native directory iterator stops reading names at
that limit, rather than allocating an unlimited `readdirSync()` result. It reports
`truncated:true` if the real source traversal exceeds that envelope;
`territorySnapshot` never labels a partial source census complete.
The original mission runtime refuses an incomplete census **before**
verification commands, model acquisition or Work process-node creation.
The name/path boundary remains the original `insideTerritory` reader,
which refuses symlink traversal and workspace escapes.

The original `list_files`, `search` and `read` actions now provide finite
readouts and evidence of truncation, rather than silently treating a clipped
result as complete. Native budgets are 4,096 listed files, 256 searched files
and 2 MiB cumulative searched file bytes, 100 matched lines, and
256 KiB per input file. A single `read` returns at most 200 lines and 64 KiB;
larger observations require narrowing the selected source range. The host
returns typed refusals for malformed read coordinates, missing files and
oversized source instead of crashing the process-node action loop. A
request for `max:0` returns no matches, explicitly marked
`truncationAuthority:"caller"`. Scanned file exhaustion or clipped
line text is `truncationAuthority:"resource"`.

The [original native receiving workflow](.github/workflows/software-mission-bounded-native.yml)
packs and installs the two exact original tool dependencies into a clean
consumer and runs the existing agent-tool test suite on Node 22 and 24,
including adverse large-source, listing, search, line-window and
incomplete-inventory cases. The separate full Software Mission dependency
graph remains blocked by the published RMN typing `workspace:*` defect.
An independently tested observation limit is **not** a kernel sandbox,
a complete mission run, a SignCell/SignChain receipt, or customer acceptance.

A source tree at a directory-entry ceiling receives `truncated:true` even
if no additional files can be recovered. The limit applies before sorting:
only a complete directory may be used as a deterministic complete census;
a partial one is explicitly refused at the original mission entrance.
Native tests exercise flat-tree fanout above the ceiling and preserve the
previous exact-provider installed consumer receiving and host boundary.

The source census also refuses completeness if a scanned directory contains
unobserved symlinks, sockets, device entries or named pipes. Such entries are
neither ordinary source files nor silently accepted absences. The original
mission runtime already rejects `truncated:true` before starting a new
process node. Ordinary-file source trees remain admitted. The native
agent-tool tests independently inspect a symlink pointing outside the
territory, require incomplete listing and search, and confirm the original
symlink read guard still rejects its traversal.
