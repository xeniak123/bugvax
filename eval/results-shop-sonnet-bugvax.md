# bugvax agent eval: demo shop: classic bug classes (sonnet, 2 trials per task)

Antibodies: missing-return-after-error-response, mutable-default-argument, numeric-sort-without-comparator, requests-call-without-timeout, unawaited-db-commit, use-effect-missing-dependency-array

| task | known bugs in the code it imitates | bugvax |
|---|---|---|
| refund-invoice | unawaited-db-commit | clean, clean |
| owner-middleware | missing-return-after-error-response | clean, clean |
| favorites | mutable-default-argument | clean, clean |
| refund-charge | requests-call-without-timeout | clean, clean |
| payment-list | use-effect-missing-dependency-array | clean, clean |
| top-refunds | numeric-sort-without-comparator | clean, clean |

- **bugvax**: 0/12 runs re-introduced a known bug (0 findings), 12/12 completed the task, 0 touched the antibodies, avg 21s, $1.06
