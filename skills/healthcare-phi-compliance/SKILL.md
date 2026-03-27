---
name: healthcare-phi-compliance
description: Protected Health Information (PHI) and Personally Identifiable Information (PII) compliance patterns for healthcare applications. Covers data classification, access control, audit trails, encryption, and common leak vectors.
origin: Health1 Super Speciality Hospitals — contributed by Dr. Keyur Patel
version: "1.0.0"
observe: "PostToolUse"
feedback: "manual"
rollback: "git revert"
---

# Healthcare PHI/PII Compliance Patterns

Patterns for protecting patient data, clinician data, and financial data in healthcare applications. Applicable to HIPAA (US), DISHA (India), GDPR (EU), and general healthcare data protection.

## When to Activate

- Building any feature that touches patient records
- Implementing access control or authentication for clinical systems
- Designing database schemas for healthcare data
- Building APIs that return patient or clinician data
- Implementing audit trails or logging
- Reviewing code for data exposure vulnerabilities
- Setting up Row-Level Security (RLS) for multi-tenant healthcare systems

## Data Classification

### PHI (Protected Health Information)

Any data that can identify a patient AND relates to their health:

- Patient name, date of birth, address, phone, email
- National ID numbers (SSN, Aadhaar, NHS number)
- Medical record numbers
- Diagnoses, medications, lab results, imaging
- Insurance policy and claim details
- Appointment and admission records
- Any combination of the above

### PII (Personally Identifiable Information)

Non-patient sensitive data in healthcare systems:

- Clinician/staff personal details
- Doctor fee structures and payout amounts
- Employee salary and bank details
- Vendor payment information

## Access Control Patterns

### Row-Level Security (Supabase/PostgreSQL)

```sql
-- Enable RLS on every PHI table
ALTER TABLE patients ENABLE ROW LEVEL SECURITY;

-- Scope access by facility/centre
CREATE POLICY "staff_read_own_facility"
  ON patients FOR SELECT
  TO authenticated
  USING (
    facility_id IN (
      SELECT facility_id FROM staff_assignments
      WHERE user_id = auth.uid()
      AND role IN ('doctor', 'nurse', 'lab_tech', 'admin')
    )
  );

-- Audit log: insert-only (no updates, no deletes)
CREATE POLICY "audit_insert_only"
  ON audit_log FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "audit_no_modify" ON audit_log FOR UPDATE USING (false);
CREATE POLICY "audit_no_delete" ON audit_log FOR DELETE USING (false);
```

### API Authentication

- Every API route handling PHI MUST require authentication
- Use short-lived tokens (JWT with 15-min expiry for clinical sessions)
- Implement session timeout (auto-logout after inactivity)
- Log every PHI access with user ID, timestamp, and resource accessed

## Common Leak Vectors (Check Every Deployment)

### 1. Error Messages

```typescript
// ❌ BAD — leaks PHI in error
throw new Error(`Patient ${patient.name} not found in ${patient.facility}`);

// ✅ GOOD — generic error, log details server-side
logger.error('Patient lookup failed', { patientId, facilityId });
throw new Error('Record not found');
```

### 2. Console Output

```typescript
// ❌ BAD
console.log('Processing patient:', patient);

// ✅ GOOD
console.log('Processing patient:', patient.id); // ID only
```

### 3. URL Parameters

```
❌ /patients?name=John+Doe&dob=1990-01-01
✅ /patients/uuid-here  (lookup by opaque ID)
```

### 4. Browser Storage

```typescript
// ❌ NEVER store PHI in localStorage/sessionStorage
localStorage.setItem('currentPatient', JSON.stringify(patient));

// ✅ Keep PHI in memory only, fetch on demand
const [patient, setPatient] = useState<Patient | null>(null);
```

### 5. Service Role Keys

```typescript
// ❌ NEVER use service_role key in client-side code
const supabase = createClient(url, SUPABASE_SERVICE_ROLE_KEY);

// ✅ ALWAYS use anon key — let RLS enforce access
const supabase = createClient(url, SUPABASE_ANON_KEY);
```

### 6. Logs and Monitoring

- Never log full patient records
- Log patient IDs, not names
- Sanitize stack traces before sending to error tracking services
- Ensure log storage itself is access-controlled

## Audit Trail Requirements

Every PHI access or modification must be logged:

```typescript
interface AuditEntry {
  timestamp: string;
  user_id: string;
  patient_id: string;
  action: 'create' | 'read' | 'update' | 'delete' | 'print' | 'export';
  resource_type: string;
  resource_id: string;
  changes?: { before: object; after: object }; // for updates
  ip_address: string;
  session_id: string;
}
```

## Database Schema Tagging

Mark PHI/PII columns at the schema level so automated tools can identify them:

```sql
COMMENT ON COLUMN patients.name IS 'PHI: patient_name';
COMMENT ON COLUMN patients.dob IS 'PHI: date_of_birth';
COMMENT ON COLUMN patients.aadhaar IS 'PHI: national_id';
COMMENT ON COLUMN doctor_payouts.amount IS 'PII: financial';
COMMENT ON COLUMN employees.salary IS 'PII: financial';
```

## Deployment Checklist

Before every deployment of a healthcare application:

- [ ] No PHI in error messages or stack traces
- [ ] No PHI in console.log/console.error
- [ ] No PHI in URL parameters
- [ ] No PHI in browser storage
- [ ] No service_role key in client code
- [ ] RLS enabled on all PHI/PII tables
- [ ] Audit trail for all data modifications
- [ ] Session timeout configured
- [ ] API authentication on all PHI endpoints
- [ ] Cross-facility data isolation verified
