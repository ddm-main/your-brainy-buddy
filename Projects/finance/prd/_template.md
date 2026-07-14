# {Module Name}

> Status · Phase · Priority · Owner surfaces (routes + edge fns + libs)

## 1. Purpose
One paragraph. The "why", tied to a concrete Deepak outcome.

## 2. UI/UX Layout
ASCII wireframe. HUD components (`HudPanel`, `HudSelect`, `KineticNumber`,
`ContentPanel`). Design tokens (`--accent`, `--edge`, `--text-dim`).

## 3. User Journey
1. Happy path (numbered).
2. Alt path A.
3. Alt path B.
4. Failure path.

## 4. Database Schema
DDL fragments (existing + planned). Indexes. Retention.

## 5. Supabase Tables
Table names + column-level notes for the columns this module reads/writes.

## 6. Relationships
FK map. ASCII ERD fragment.

## 7. Edge Functions
`name` — method, `verify_jwt`, request shape, response shape, secrets used.

## 8. Business Logic
Pure lib functions in `src/lib/*`. Formulas. Invariants.

## 9. AI Logic
Model id, `brain-router` branch, prompt shape, tools exposed, structured
output schema (Zod fragment).

## 10. Automation Rules
Cron schedule, trigger event, idempotency key.

## 11. Validation Rules
Zod shapes, DB constraints, client guards.

## 12. Error Handling
User-visible copy. Retry policy. Dead-letter.

## 13. Notifications
Toasts (`useUi.push`). `finance_alerts` rows. Brief section.

## 14. Analytics
Event names, dimensions, KPIs surfaced.

## 15. Security
RLS predicate. PII fields. Encryption. Rate-limit tier.

## 16. API Flow
ASCII sequence diagram: client → route → edge fn → provider → back.

## 17. State Management
Stores touched (`uiStore`, `contentStore`, `brainStore`, etc.).
React-Query keys + invalidation triggers.

## 18. Performance
Query cost budget. Index list. N+1 guards. Bundle-size ceiling.

## 19. Mobile Behavior
`<1024px` collapse rules.

## 20. Desktop Behavior
Grid slot. Keyboard shortcuts.

## 21. Future Enhancements
Explicitly out-of-scope now.

## 22. Acceptance Criteria + Test Cases
- **AC-1** Given / When / Then.
- **AC-2** …
- Tests: `tests/{module}.test.ts` — list case names.
