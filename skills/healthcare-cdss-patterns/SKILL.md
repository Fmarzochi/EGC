---
name: healthcare-cdss-patterns
description: Clinical Decision Support System (CDSS) development patterns. Drug interaction checking, dose validation, clinical scoring (NEWS2, qSOFA), alert severity classification, and integration into EMR workflows.
origin: Health1 Super Speciality Hospitals — contributed by Dr. Keyur Patel
version: "1.0.0"
observe: "PostToolUse"
feedback: "manual"
rollback: "git revert"
---

# Healthcare CDSS Development Patterns

Patterns for building Clinical Decision Support Systems that integrate into EMR workflows. CDSS modules are patient safety critical — zero tolerance for false negatives.

## When to Activate

- Implementing drug interaction checking
- Building dose validation engines
- Implementing clinical scoring systems (NEWS2, qSOFA, APACHE, GCS)
- Designing alert systems for abnormal clinical values
- Building medication order entry with safety checks
- Integrating lab result interpretation with clinical context

## Architecture

```
EMR UI
  ↓ (user enters data)
CDSS Engine (pure functions, no side effects)
  ├── Drug Interaction Checker
  ├── Dose Validator
  ├── Clinical Scoring (NEWS2, qSOFA, etc.)
  └── Alert Classifier
  ↓ (returns alerts)
EMR UI (displays alerts inline, blocks if critical)
```

**Key principle:** The CDSS engine should be a pure function library with zero side effects. Input clinical data, output alerts. This makes it fully testable.

## Drug Interaction Checking

### Data Model

```typescript
interface DrugInteractionPair {
  drugA: string;           // generic name
  drugB: string;           // generic name
  severity: 'critical' | 'major' | 'minor';
  mechanism: string;       // e.g., "CYP3A4 inhibition"
  clinicalEffect: string;  // e.g., "Increased bleeding risk"
  recommendation: string;  // e.g., "Avoid combination" or "Monitor INR closely"
}

interface InteractionAlert {
  severity: 'critical' | 'major' | 'minor';
  pair: [string, string];
  message: string;
  recommendation: string;
}
```

### Implementation Pattern

```typescript
function checkInteractions(
  newDrug: string,
  currentMedications: string[],
  allergyList: string[]
): InteractionAlert[] {
  const alerts: InteractionAlert[] = [];

  // Check drug-drug interactions
  for (const current of currentMedications) {
    const interaction = findInteraction(newDrug, current);
    if (interaction) {
      alerts.push({
        severity: interaction.severity,
        pair: [newDrug, current],
        message: interaction.clinicalEffect,
        recommendation: interaction.recommendation
      });
    }
  }

  // Check drug-allergy interactions
  for (const allergy of allergyList) {
    if (isCrossReactive(newDrug, allergy)) {
      alerts.push({
        severity: 'critical',
        pair: [newDrug, allergy],
        message: `Cross-reactivity with documented allergy: ${allergy}`,
        recommendation: 'Do not prescribe without allergy consultation'
      });
    }
  }

  // Sort by severity (critical first)
  return alerts.sort((a, b) =>
    severityOrder(a.severity) - severityOrder(b.severity)
  );
}
```

### Interaction pairs must be bidirectional

If Drug A interacts with Drug B, then Drug B interacts with Drug A. Store once, check both directions.

## Dose Validation

```typescript
interface DoseValidationResult {
  valid: boolean;
  message: string;
  suggestedRange: { min: number; max: number; unit: string };
  factors: string[]; // what was considered (weight, age, renal function)
}

function validateDose(
  drug: string,
  dose: number,
  route: 'oral' | 'iv' | 'im' | 'sc' | 'topical',
  patientWeight?: number,
  patientAge?: number,
  renalFunction?: number // eGFR
): DoseValidationResult {
  const rules = getDoseRules(drug, route);
  if (!rules) return { valid: true, message: 'No validation rules available', suggestedRange: null, factors: [] };

  // Weight-based dosing
  if (rules.weightBased && patientWeight) {
    const maxDose = rules.maxPerKg * patientWeight;
    if (dose > maxDose) {
      return {
        valid: false,
        message: `Dose ${dose}${rules.unit} exceeds max ${maxDose}${rules.unit} for ${patientWeight}kg patient`,
        suggestedRange: { min: rules.minPerKg * patientWeight, max: maxDose, unit: rules.unit },
        factors: ['weight']
      };
    }
  }

  // Absolute max dose
  if (dose > rules.absoluteMax) {
    return {
      valid: false,
      message: `Dose ${dose}${rules.unit} exceeds absolute max ${rules.absoluteMax}${rules.unit}`,
      suggestedRange: { min: rules.typicalMin, max: rules.absoluteMax, unit: rules.unit },
      factors: ['absolute_max']
    };
  }

  return { valid: true, message: 'Within range', suggestedRange: { min: rules.typicalMin, max: rules.typicalMax, unit: rules.unit }, factors: [] };
}
```

## Clinical Scoring: NEWS2

National Early Warning Score 2 — standardized assessment of acute illness severity:

```typescript
interface NEWS2Input {
  respiratoryRate: number;
  oxygenSaturation: number;
  supplementalOxygen: boolean;
  temperature: number;
  systolicBP: number;
  heartRate: number;
  consciousness: 'alert' | 'voice' | 'pain' | 'unresponsive';
}

interface NEWS2Result {
  total: number;           // 0-20
  risk: 'low' | 'low-medium' | 'medium' | 'high';
  components: Record<string, number>;
  escalation: string;      // recommended clinical action
}
```

Scoring tables must match the Royal College of Physicians NEWS2 specification exactly. Any deviation is a patient safety issue.

## Alert Severity and UI Behavior

| Severity | UI Behavior | Clinician Action Required |
|----------|-------------|--------------------------|
| Critical | Block action. Non-dismissable modal. Red. | Must document override reason to proceed |
| Major | Warning banner inline. Orange. | Must acknowledge before proceeding |
| Minor | Info note inline. Yellow. | Awareness only, no action required |

**Rules:**
- Critical alerts must NEVER be auto-dismissed
- Critical alerts must NEVER be toast notifications
- Override reasons must be stored in the audit trail
- Alert fatigue is real — only use critical for genuinely dangerous situations

## Testing CDSS (Zero Tolerance for False Negatives)

```typescript
describe('CDSS — Patient Safety', () => {
  // Every known interaction pair MUST fire
  INTERACTION_PAIRS.forEach(({ drugA, drugB, severity }) => {
    it(`detects ${drugA} + ${drugB} (${severity})`, () => {
      const alerts = checkInteractions(drugA, [drugB], []);
      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts[0].severity).toBe(severity);
    });

    // Bidirectional check
    it(`detects ${drugB} + ${drugA} (reverse)`, () => {
      const alerts = checkInteractions(drugB, [drugA], []);
      expect(alerts.length).toBeGreaterThan(0);
    });
  });

  // Dose validation
  DOSE_RULES.forEach((rule) => {
    it(`validates ${rule.drug}: ${rule.scenario}`, () => {
      const result = validateDose(rule.drug, rule.dose, rule.route, rule.weight, rule.age);
      expect(result.valid).toBe(rule.expectedValid);
    });
  });

  // No silent failures
  it('handles malformed drug data gracefully', () => {
    expect(() => checkInteractions('', [], [])).not.toThrow();
    expect(() => checkInteractions(null as any, [], [])).not.toThrow();
  });
});
```

**Pass criteria: 100%.** A single missed interaction is a patient safety event.

## Anti-Patterns

- ❌ Making CDSS checks optional or skippable without documented reason
- ❌ Implementing interaction checks as toast notifications
- ❌ Using `any` types for drug or clinical data
- ❌ Hardcoding interaction pairs instead of using a maintainable data structure
- ❌ Testing with mocked data only (must test with real drug names)
- ❌ Silently catching errors in CDSS engine (must surface failures loudly)
