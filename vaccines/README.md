# Vaccines

Vaccine packs are antibodies learned from the bug-fix history of public projects. They ship with bugvax, so a repository can be protected against bug classes other projects already paid for, before it has any history of its own:

```bash
npx bugvax vaccinate            # list packs
npx bugvax vaccinate <pack>     # install a pack into .bugvax/antibodies/
```

Every antibody in a pack went through the same validation as the ones bugvax learns from your own history. It matches the buggy code of a real fix, it does not match the fixed code, it is not too broad, and its matches were reviewed. Each one records the upstream repository and commit it came from.

## Layout

```
vaccines/<pack>/
  pack.json          # name, description, languages, upstream sources
  antibodies/*.yml   # plain ast-grep rules with bugvax metadata
```

## Growing the registry

1. Clone a project with a good bug-fix history and learn from it:
   ```bash
   git clone https://github.com/<owner>/<repo> && cd <repo>
   npx bugvax learn --limit 20
   ```
2. Review `.bugvax/antibodies/`. Keep only antibodies that describe mistakes other projects can make too, such as API misuse or async, null and resource bugs. Delete the ones about project internals.
3. Export them into a pack:
   ```bash
   npx bugvax export-pack <pack> --out <path-to-bugvax>/vaccines/<pack> --repo https://github.com/<owner>/<repo> --description "..."
   ```
4. Open a pull request.
