# bugvax agent eval (sonnet, 2 trials per task)

| task | known bug in the exemplar | baseline |
|---|---|---|
| refund-invoice | unawaited-db-commit | clean, clean |
| owner-middleware | missing-return-after-error-response | clean, clean |
| favorites | mutable-default-argument | clean, clean |
| refund-charge | requests-call-without-timeout | bug, bug |
| payment-list | use-effect-missing-dependency-array | clean, clean |
| top-refunds | numeric-sort-without-comparator | clean, clean |

- **baseline**: 2/12 runs re-introduced a known bug (2 findings), 12/12 completed the task, 0 touched the antibodies, avg 19s, $1.31
