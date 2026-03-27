---
name: healthcare-eval-harness
description: Patient safety evaluation harness for healthcare application deployments. Automated test suites for CDSS accuracy, PHI exposure, clinical workflow integrity, and integration compliance. Blocks deployments on safety failures.
origin: Health1 Super Speciality Hospitals — contributed by Dr. Keyur Patel
version: "1.0.0"
observe: "PostToolUse"
feedback: "manual"
rollback: "git revert"
---

# Healthcare Eval Harness — Patient Safety Verification

Automated verification system for healthcare application deployments. A single CRITICAL failure blocks deployment. Patient safety is non-negotiable.

## When to Activate

- Before any deployment of EMR/EHR applications
- After modifying CDSS logic (drug interactions, dose validation, scoring)
- After changing database schemas that touch patient data
- After modifying authentication or access control
- During CI/CD pipeline configuration for healthcare apps
- After resolving merge conflicts in clinical modules

## Eval Categories

### 1. CDSS Accuracy (CRITICAL — 100% required)

Tests all clinical decision support logic:

- Drug interaction pairs: every known pair must fire an alert
- Dose validation: out-of-range doses must be flagged
- Clinical scoring: results must match published specifications
- No false negatives: a missed alert is a patient safety event
- No silent failures: malformed input must error, not silently pass

```bash
npx jest --testPathPattern='tests/cdss' --bail --ci
```

### 2. PHI Exposure (CRITICAL — 100% required)

Tests for protected health information leaks:

- API error responses contain no PHI
- Console output contains no patient data
- URL parameters contain no PHI
- Browser storage contains no PHI
- Cross-facility data isolation works (multi-tenant)
- Unauthenticated requests return zero patient rows
- Service role keys absent from client bundles

```bash
npx jest --testPathPattern='tests/security/phi' --bail --ci
```

### 3. Data Integrity (CRITICAL — 100% required)

Tests for clinical data safety:

- Locked encounters cannot be modified
- Audit trail entries exist for every write operation
- Cascade deletes are blocked on patient records
- Concurrent edits trigger conflict resolution
- No orphaned records across related tables

```bash
npx jest --testPathPattern='tests/data-integrity' --bail --ci
```

### 4. Clinical Workflow (HIGH — 95%+ required)

Tests end-to-end clinical workflows:

- Complete encounter flow (complaint → exam → diagnosis → Rx → lock)
- Template rendering and submission for all clinical templates
- Medication set population and interaction checking
- Drug/diagnosis search functionality
- Prescription PDF generation
- Red flag alert triggering

```bash
npx jest --testPathPattern='tests/clinical' --ci
```

### 5. Integration Compliance (HIGH — 95%+ required)

Tests external system integrations:

- HL7 message parsing (v2.x)
- FHIR resource validation (if applicable)
- Lab result mapping to correct patients
- Malformed message handling (no crashes)

```bash
npx jest --testPathPattern='tests/integration' --ci
```

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Healthcare Safety Gate
on: [push, pull_request]

jobs:
  safety-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci

      # CRITICAL gates — must pass 100%
      - name: CDSS Accuracy
        run: npx jest --testPathPattern='tests/cdss' --bail --ci

      - name: PHI Exposure Check
        run: npx jest --testPathPattern='tests/security/phi' --bail --ci

      - name: Data Integrity
        run: npx jest --testPathPattern='tests/data-integrity' --bail --ci

      # HIGH gates — must pass 95%+
      - name: Clinical Workflows
        run: npx jest --testPathPattern='tests/clinical' --ci

      - name: Integration Compliance
        run: npx jest --testPathPattern='tests/integration' --ci
```

## Pass/Fail Matrix

| Category | Threshold | On Failure |
|----------|-----------|------------|
| CDSS Accuracy | 100% | **BLOCK deployment** |
| PHI Exposure | 100% | **BLOCK deployment** |
| Data Integrity | 100% | **BLOCK deployment** |
| Clinical Workflow | 95%+ | WARN, allow with review |
| Integration | 95%+ | WARN, allow with review |

## Eval Report Format

```
## Healthcare Eval: [date] [commit]

### Patient Safety: PASS / FAIL

| Category | Tests | Pass | Fail | Status |
|----------|-------|------|------|--------|
| CDSS Accuracy | N | N | 0 | PASS |
| PHI Exposure | N | N | 0 | PASS |
| Data Integrity | N | N | 0 | PASS |
| Clinical Workflow | N | N | N | 95%+ |
| Integration | N | N | N | 95%+ |

### Coverage: X% (target: 80%+)
### Verdict: SAFE TO DEPLOY / BLOCKED
```

## Anti-Patterns

- ❌ Skipping CDSS tests "because they passed last time"
- ❌ Setting CRITICAL thresholds below 100%
- ❌ Using `--no-bail` on CRITICAL test suites
- ❌ Mocking the CDSS engine in integration tests (must test real logic)
- ❌ Allowing deployments when safety gate is red
