## Code style

- Functional style; isolate and make effects explicit.
- Comment only when intent cannot be inferred from names and types alone. No slop comments
- No `any` or non-null assertions (`!`) in TypeScript unless necessary.
- Implementation checklist
  1. Does this need to exist?   → no: skip it (YAGNI)
  2. Already in this codebase?  → reuse it, don't rewrite
  3. Stdlib does it?            → use it
  4. Native platform feature?   → use it
  5. Installed dependency?      → use it
  6. One line?                  → one line
  7. Only then: the minimum that works

## Behavioral rules
- Tag unverified claims [SPECULATION] inline. MUST prefix any claim not backed by evidence
- Always cite evidence/claim sources inline. MUST provide source for any non-trivial claim, ideally with a link.




