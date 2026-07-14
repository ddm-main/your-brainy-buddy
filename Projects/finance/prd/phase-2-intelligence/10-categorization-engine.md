# Categorization Engine

> 🟡 partial · Phase 2 · P0 · `src/lib/categorize.ts`, `category_rules` table
> Gap: `learnFromCorrection` not wired from Txns inline edits (Wave D-1).

## 1. Purpose
Every txn gets a category deterministically, then improves as Deepak
corrects. No opaque model calls per row.

## 2. UI/UX Layout
Category dropdown in Txns row + bulk categorize toolbar. Suggestion
chips ranked by score.

## 3. User Journey
1. Parser sets initial category from merchant regex.
2. User edits category → `learnFromCorrection` writes rule.
3. Future matching merchants classified from the rule.

## 4. Database Schema
`category_rules(id, user_id, merchant_normalized, category,
source enum{seed,merchant,user}, hits int, last_used_at, timestamps)`.
Unique `(user_id, merchant_normalized, category)`.

## 5. Supabase Tables
`category_rules`, `transactions` (read/write category).

## 6. Relationships
```
transactions.merchant → normalizeMerchant() → category_rules.merchant_normalized
```

## 7. Edge Functions
None. Client + rules only.

## 8. Business Logic
`categorize.ts`:
- `score(txn, rules)` → picks best `(category, weight)` from
  matching rules; user > merchant > seed.
- `learnFromCorrection(txn, category)` → upsert rule with
  `source='user'`, increment `hits`.

## 9. AI Logic
Optional LLM assist for unknown merchants (batched nightly by
`finance-detect`) — writes `source='merchant'` rules with confidence.

## 10. Automation Rules
Nightly `finance-detect` batches uncategorised txns for LLM assist.

## 11. Validation Rules
- `category` non-empty ≤ 40 chars.
- `merchant_normalized` lower-case, whitespace-collapsed.

## 12. Error Handling
Upsert conflict → increment hits, don't error.

## 13. Notifications
None.

## 14. Analytics
`finance.cat.learned{source}`, `finance.cat.override{merchant}`.

## 15. Security
RLS `user_id = auth.uid()`. No cross-user leakage; rules never merged
across users.

## 16. API Flow
```
Txns edit → supabase.update(transactions)
         → supabase.upsert(category_rules)
         → contentStore.bumpFinanceVersion
```

## 17. State Management
`contentStore.financeVersion`.

## 18. Performance
Rule lookup O(1) via `Map<merchant, rules[]>` cached per session.

## 19. Mobile Behavior
Dropdown becomes native select.

## 20. Desktop Behavior
Dropdown with keyboard nav.

## 21. Future Enhancements
- Category budget suggestions from rule stats.
- Merge similar categories UI ("Food" vs "Dining").

## 22. Acceptance Criteria + Test Cases
- **AC-1** Correcting Zomato → "Food" writes exactly one rule row.
- **AC-2** Next Zomato txn preselects "Food".
- **AC-3** User rule outranks merchant rule of same merchant.
- Tests: `tests/categorize.test.ts` — score ordering, upsert, hit
  increment.
