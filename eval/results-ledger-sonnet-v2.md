# bugvax agent eval: ledger: project-specific conventions learned from its history (sonnet, 2 trials per task)

Antibodies: bus-emit-instead-of-outbox-enqueue, db-query-missing-tenant-scope, manual-float-to-cents-conversion, new-date-on-db-timestamp, unchecked-get-account-result

| task | known bugs in the code it imitates | baseline | bugvax |
|---|---|---|---|
| withdraw | deposit(): no null check on getAccount, Math.round cents, bus.emit | 3 bugs, 3 bugs | clean, clean |
| export-csv | monthlyTotals(): query without tenant scope, new Date(row.date) | clean, 1 bug | clean, clean |
| charge-fee | deposit(): no null check on getAccount, bus.emit | 2 bugs, 2 bugs | clean, clean |

- **baseline**: 5/6 runs re-introduced a known bug (11 findings), 6/6 completed the task, 0 touched the antibodies, avg 25s, $0.85
- **bugvax**: 0/6 runs re-introduced a known bug (0 findings), 6/6 completed the task, 0 touched the antibodies, avg 35s, $0.92
