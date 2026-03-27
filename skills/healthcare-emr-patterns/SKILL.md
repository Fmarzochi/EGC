---
name: healthcare-emr-patterns
description: EMR/EHR development patterns for healthcare applications. Clinical safety, encounter workflows, prescription generation, clinical decision support integration, and accessibility-first UI for medical data entry.
origin: Health1 Super Speciality Hospitals — contributed by Dr. Keyur Patel
version: "1.0.0"
observe: "PostToolUse"
feedback: "manual"
rollback: "git revert"
---

# Healthcare EMR Development Patterns

Patterns for building Electronic Medical Record (EMR) and Electronic Health Record (EHR) systems. Prioritizes patient safety, clinical accuracy, and practitioner efficiency.

## When to Activate

- Building patient encounter workflows (complaint → exam → diagnosis → prescription)
- Implementing clinical note-taking (structured + free text + voice-to-text)
- Designing prescription/medication modules with drug interaction checking
- Integrating Clinical Decision Support Systems (CDSS)
- Building lab result displays with reference range highlighting
- Implementing audit trails for clinical data
- Designing healthcare-accessible UIs for clinical data entry

## Core Principles

### 1. Patient Safety First

Every design decision must be evaluated against: "Could this harm a patient?"

- Drug interactions MUST alert, not silently pass
- Abnormal lab values MUST be visually flagged
- Critical vitals MUST trigger escalation workflows
- No clinical data modification without audit trail

### 2. Single-Page Encounter Flow

Clinical encounters should flow vertically on a single page — no tab switching during patient interaction:

```
Patient Header (sticky — always visible)
├── Demographics, allergies, active medications
│
Encounter Flow (vertical scroll)
├── 1. Chief Complaint (structured templates + free text)
├── 2. History of Present Illness
├── 3. Physical Examination (system-wise)
├── 4. Vitals (auto-trigger clinical scoring)
├── 5. Diagnosis (ICD-10/SNOMED search)
├── 6. Medications (drug DB + interaction check)
├── 7. Investigations (lab/radiology orders)
├── 8. Plan & Follow-up
└── 9. Sign / Lock / Print
```

### 3. Smart Template System

Build templates for common presentations:

```typescript
interface ClinicalTemplate {
  id: string;
  name: string;             // e.g., "Chest Pain"
  chips: string[];          // clickable symptom chips
  requiredFields: string[]; // mandatory data points
  redFlags: string[];       // triggers non-dismissable alert
  icdSuggestions: string[]; // pre-mapped diagnosis codes
}
```

**Red flags** in any template must trigger a visible, non-dismissable alert — NOT a toast notification.

### 4. Medication Safety Pattern

```
User selects drug
  → Check current medications for interactions
  → Check encounter medications for interactions
  → Check patient allergies
  → Validate dose against weight/age/renal function
  → Display alerts (critical = block, major = require override reason)
  → Log override reason if clinician proceeds
```

Critical interactions should **block prescribing by default**. The clinician must explicitly override with a documented reason.

### 5. Locked Encounter Pattern

Once a clinical encounter is signed:
- No edits allowed — only addendum
- Addendum is a new record linked to the original
- Both original and addendum appear in the patient timeline
- Audit trail captures who signed, when, and any addenda

## UI Patterns for Clinical Data

### Vitals Display

- Current values with normal range highlighting (green/yellow/red)
- Trend arrows comparing to previous measurement
- Clinical scoring auto-calculated (NEWS2, qSOFA, MEWS)
- Scoring result displayed inline with escalation guidance

### Lab Results Display

- Normal range highlighting with institution-specific ranges
- Previous value comparison (trend)
- Critical values flagged with non-dismissable alert
- Timestamp of collection and analysis
- Pending orders shown with expected turnaround

### Prescription PDF

- One-click generation
- Patient demographics, allergies, diagnosis
- Drug name (generic + brand), dose, route, frequency, duration
- Clinician signature block
- QR code linking to digital record (optional)

## Accessibility for Healthcare

Healthcare UIs have stricter accessibility requirements than typical web apps:

- **4.5:1 minimum contrast** (WCAG AA) — clinicians work in varied lighting
- **Large touch targets** (44x44px minimum) — for gloved/rushed interaction
- **Keyboard navigation** — for power users entering data rapidly
- **No color-only indicators** — always pair color with text/icon (colorblind clinicians)
- **Screen reader labels** on all form fields — for voice-assisted data entry
- **No auto-dismissing toasts** for clinical alerts — clinician must actively acknowledge

## Anti-Patterns

- ❌ Storing clinical data in browser localStorage
- ❌ Silent failures in drug interaction checking
- ❌ Dismissable toasts for critical clinical alerts
- ❌ Tab-based encounter UIs that fragment the clinical workflow
- ❌ Allowing edits to signed/locked encounters
- ❌ Displaying clinical data without audit trail
- ❌ Using `any` type for clinical data structures
