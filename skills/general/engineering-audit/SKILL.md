---
name: engineering-audit
description: Engineering health assessment patterns, scoring thresholds, refactoring techniques, and observability guidelines for the engineering-auditor agent and commands.
origin: EGC
---

# Engineering Audit

Reference knowledge for the `engineering-auditor` agent and the `/engineering-audit` and `/engineering-fix` commands.

## When to Activate

- Before a release or major refactor
- When onboarding a new project and assessing technical debt
- When CI quality gates start failing repeatedly
- When a team member asks "how healthy is this codebase?"
- Periodically as part of engineering excellence initiatives

---

## Metric Definitions

### Cyclomatic Complexity (CC)

Number of linearly independent paths through a function. Measured by ESLint `complexity` rule.

| CC | Meaning |
|---|---|
| 1–5 | Simple, testable |
| 6–10 | Moderate — acceptable |
| 11–20 | Complex — refactor soon |
| 21–50 | Very complex — high risk |
| > 50 | Unmaintainable |

### Cognitive Complexity

How difficult a function is to understand, accounting for nesting and control flow breaks. Different from CC: a function with three nested `if`s scores higher than three separate `if`s at the same level.

### Nesting Depth

Maximum levels of nested blocks (if/for/try). Measured by ESLint `max-depth` rule. Threshold: 4.

### Function Length

Lines of code per function. Measured by ESLint `max-lines-per-function`. Threshold: 50 lines.

### File Length

Total lines per file. Measured by ESLint `max-lines`. Threshold: 300 lines.

### Maintainability Index

Composite score derived from CC, function length, and Halstead volume. Higher is better (0–100).

### Technical Debt Ratio

Estimated remediation time relative to development time. SonarQube-style metric: < 5% = A, 6–10% = B, 11–20% = C, 21–50% = D, > 50% = E.

---

## Scoring Thresholds

### Per-Dimension Score (0–10)

**Maintainability**
- 10: All functions CC ≤ 5, no function > 30 lines
- 7: Avg CC < 10, no function > 50 lines
- 4: Avg CC < 20, some functions 50–100 lines
- 0–3: Any CC > 25, or functions > 200 lines

**Security**
- 10: 0 npm audit vulnerabilities
- 7: Low severity only
- 4: Moderate vulnerabilities
- 0–3: Any critical or high vulnerability

**Testing**
- 10: > 90% line coverage, test:source ratio > 1.0
- 7: > 60% coverage
- 4: > 30% coverage
- 0–3: < 30% coverage or no test suite

**Architecture**
- 10: 0 circular dependencies, no god files
- 7: < 3 circular deps
- 4: < 10 circular deps
- 0–3: ≥ 10 circular deps or multiple god files

**Documentation**
- 10: > 80% public APIs documented (JSDoc)
- 7: > 50%
- 4: > 20%
- 0–3: < 20%

**Lint Health**
- 10: 0 errors, 0 warnings
- 7: 0 errors, < 10 warnings
- 4: < 10 errors
- 0–3: ≥ 10 errors

**Type Safety** (TypeScript only)
- 10: 0 type errors, 0 `any` usages
- 7: 0 errors, < 5 `any`
- 4: < 10 errors
- 0–3: ≥ 10 errors or widespread `any`

**Build Health**
- 10: Build passes, no warnings
- 7: Build passes with warnings
- 4: Build passes on some targets
- 0–3: Build fails

### Weighted Engineering Score

| Dimension | Weight |
|---|---|
| Maintainability | 20% |
| Security | 20% |
| Testing | 15% |
| Architecture | 15% |
| Documentation | 10% |
| Lint Health | 10% |
| Type Safety | 5% |
| Build Health | 5% |

---

## Refactoring Techniques

### Extract Method

Split a long or complex function into smaller, named functions.

**Before:**
```typescript
function processOrder(order: Order) {
  if (!order.items || order.items.length === 0) return;
  let total = 0;
  for (const item of order.items) {
    total += item.price * item.quantity;
    if (item.discount) total -= item.discount;
  }
  const tax = total * 0.1;
  total += tax;
  if (order.coupon === 'SAVE10') total -= total * 0.1;
  order.total = total;
  sendConfirmationEmail(order);
}
```

**After:**
```typescript
function calculateSubtotal(items: OrderItem[]): number {
  return items.reduce((sum, item) => {
    const lineTotal = item.price * item.quantity;
    return sum + lineTotal - (item.discount ?? 0);
  }, 0);
}

function applyTaxAndCoupons(subtotal: number, coupon?: string): number {
  const withTax = subtotal * 1.1;
  return coupon === 'SAVE10' ? withTax * 0.9 : withTax;
}

function processOrder(order: Order) {
  if (!order.items?.length) return;
  order.total = applyTaxAndCoupons(calculateSubtotal(order.items), order.coupon);
  sendConfirmationEmail(order);
}
```

### Early Return (Guard Clauses)

Replace nested conditions with early returns to reduce nesting depth.

**Before:**
```typescript
function getDiscount(user: User) {
  if (user) {
    if (user.isPremium) {
      if (user.yearsActive > 5) {
        return 0.3;
      } else {
        return 0.15;
      }
    } else {
      return 0.05;
    }
  }
  return 0;
}
```

**After:**
```typescript
function getDiscount(user: User | null): number {
  if (!user) return 0;
  if (!user.isPremium) return 0.05;
  return user.yearsActive > 5 ? 0.3 : 0.15;
}
```

### Strategy Pattern

Replace long `switch` or `if/else` chains with a strategy object.

**Before:**
```typescript
function format(value: string, type: string) {
  if (type === 'date') return new Date(value).toLocaleDateString();
  if (type === 'currency') return `$${parseFloat(value).toFixed(2)}`;
  if (type === 'percent') return `${parseFloat(value) * 100}%`;
  return value;
}
```

**After:**
```typescript
const formatters: Record<string, (v: string) => string> = {
  date: (v) => new Date(v).toLocaleDateString(),
  currency: (v) => `$${parseFloat(v).toFixed(2)}`,
  percent: (v) => `${parseFloat(v) * 100}%`,
};

function format(value: string, type: string): string {
  return (formatters[type] ?? ((v) => v))(value);
}
```

### Split Module

Break a god file into cohesive modules.

- Group by responsibility: separate data access, business logic, and presentation
- Each new file should be < 300 lines and have a single, clear purpose
- Export a barrel (`index.ts`) if consumers need to import from multiple sub-modules

### Type Narrowing

Replace `any` with precise types using guards.

**Before:**
```typescript
function process(data: any) {
  return data.value.toString();
}
```

**After:**
```typescript
interface Processable {
  value: string | number;
}

function isProcessable(data: unknown): data is Processable {
  return typeof data === 'object' && data !== null && 'value' in data;
}

function process(data: unknown): string {
  if (!isProcessable(data)) throw new TypeError('Invalid data shape');
  return data.value.toString();
}
```

### Dependency Inversion

Make high-level modules depend on abstractions, not concretions.

**Before:**
```typescript
class OrderService {
  private db = new PostgresDatabase();
  save(order: Order) { this.db.insert(order); }
}
```

**After:**
```typescript
interface Database {
  insert(record: unknown): void;
}

class OrderService {
  constructor(private db: Database) {}
  save(order: Order) { this.db.insert(order); }
}
```

---

## Audit Report Format

Reports are saved at `.egc/audits/engineering-audit-<YYYY-MM-DD>.md`.

```markdown
# Engineering Audit — <project> — <date>

## Engineering Score: X.X / 10

| Dimension | Score | Status |
|---|---|---|
| Maintainability | X.X | ok / warn / critical |
| Security | X.X | ok / warn / critical |
| ... | ... | ... |

## Findings

### CRITICAL (N)
- [file:line] description — technique

### HIGH (N)
...

## Remediation Plan

### 1. [file] — Extract Method
Root cause: ...
Impact: ...
Steps: ...

## Observability Log

| Timestamp | Tool | Files Analyzed | Issues Found |
|---|---|---|---|
| ... | ESLint | N | N |
```

---

## Observability

Every audit run appends to `.egc/audits/audit-log.jsonl`:

```jsonl
{"ts":"2026-06-07T22:00:00Z","tool":"eslint","files":42,"errors":3,"warnings":17}
{"ts":"2026-06-07T22:00:01Z","tool":"tsc","errors":0,"any_count":2}
{"ts":"2026-06-07T22:00:02Z","tool":"npm-audit","critical":0,"high":0,"moderate":1}
{"ts":"2026-06-07T22:00:03Z","score":8.6,"dimensions":{"maintainability":8.9,"security":9.7}}
```

---

## Related Skills

- `security-review` — deep security analysis
- `coding-standards` — language-specific quality standards
- `tdd-workflow` — test coverage improvement
- `plankton-code-quality` — additional quality patterns
