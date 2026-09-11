# Google Workspace communications setup

ODOS sends reminder email from the practice's own paid Google Workspace domain. The adapter is
disabled unless the practice explicitly selects `google-workspace`; the reminder worker has a
second explicit enable flag. ODOS does not hold a shared account, phone home, or copy patient data
to PerformanceOD.

## Operator prerequisites

1. Confirm the account is paid Google Workspace, not personal Gmail.
2. From a Workspace Super Admin account, review and accept Google's BAA under **Account settings →
   Legal and compliance**. The Gmail API cannot confirm BAA acceptance, so this remains a manual
   operator responsibility.
3. In a practice-owned Google Cloud project, enable Gmail API and create a service account.
4. Enable domain-wide delegation for that service account. In the Workspace Admin console, add its
   numeric client ID under **Security → Access and data control → API controls → Manage Domain Wide
   Delegation** with only:

   `https://www.googleapis.com/auth/gmail.send`

5. Choose the Workspace mailbox ODOS will impersonate, such as `info@practice.example`. If the From
   address is an alias, configure that alias in Gmail before enabling reminders.
6. Store the service-account PEM private key only in the practice's local secret configuration.
   Never commit it, paste it into a PR, or place it in a screenshot.

Configure:

```dotenv
ODOS_COMMS_EMAIL_PROVIDER=google-workspace
ODOS_TIMEZONE=America/New_York
GOOGLE_WORKSPACE_SERVICE_ACCOUNT_EMAIL=odos-comms@practice-project.iam.gserviceaccount.com
GOOGLE_WORKSPACE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n
GOOGLE_WORKSPACE_DELEGATED_USER=info@practice.example
GOOGLE_WORKSPACE_DOMAIN=practice.example
GOOGLE_WORKSPACE_FROM_ADDRESS=info@practice.example
GOOGLE_WORKSPACE_PLAN_CONFIRMED=true
ODOS_REMINDER_ENGINE_ENABLED=true
```

Restart `odos-mcp` after changing configuration. The worker defaults to a 60-second sweep, a
24-hour bounded recovery window for positive-offset campaigns, and three appointment-start
offsets: 7 days before, 1 day before, and 2 hours before. Negative-offset Appointment reminders
also scan every still-upcoming anchor whose reminder is already due, so a restart does not skip
the reminder while the appointment remains in the future. An Appointment-end campaign must still
query the standard FHIR R4 `date` parameter (`Appointment.start`) with explicit duration padding,
then filter on `Appointment.end`; it never emits the server-specific `Appointment?end` search.
Recall, no-show, birthday, reactivation, and review-request campaign rows are not included in
Slice 1.

## Manual verification

Use a synthetic local Patient and Appointment only. Set the appointment start so one configured
offset falls inside the next sweep window and verify:

- exactly one message arrives from the configured practice mailbox;
- the body contains only appointment date/time, provider, and location;
- a completed FHIR `Communication` exists with the appointment as `about`;
- a second sweep does not send a duplicate;
- setting the Patient email opt-out extension prevents the send;
- an outside-window send becomes `on-hold` until the next 8:00 a.m. patient-local opening.
- cancelling or rescheduling that Appointment before the window opens marks the held send
  `not-done` instead of delivering stale logistics.

Do not use a real patient or a production practice for this proof. Google's Workspace limits page
currently reports a 2,000-message per-user rolling 24-hour limit, but treat this figure as
PROVISIONAL: the Gmail API quota page documents separate rate limits rather than independently
corroborating the mailbox limit, and Google says limits may change without notice. This adapter
uses Gmail API rather than SMTP relay and does not claim SMTP relay's separate limits.

Primary references, accessed 2026-07-30:

- [Create access credentials and domain-wide delegation](https://developers.google.com/workspace/guides/create-credentials#domain-wide_delegation)
- [Server-to-server OAuth and delegated `sub`](https://developers.google.com/identity/protocols/oauth2/service-account)
- [Gmail API `users.messages.send`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send)
- [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Workspace Gmail sending limits](https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace)
- [Gmail API usage limits](https://developers.google.com/workspace/gmail/api/reference/quota)
- [Google Workspace HIPAA compliance and BAA acceptance](https://knowledge.workspace.google.com/admin/compliance/hipaa-compliance-with-google-workspace-and-cloud-identity)

## Communication preferences

The server applies patient suppression before the purpose/channel preference matrix, then frequency caps and quiet hours. An explicit preference cannot undo STOP or an email opt-out. Accepted START restores the four nonmarketing text preferences in the same Patient update. Marketing SMS retains the legacy recorded-consent requirement; marketing email defaults ON while email opt-outs still block. A deliberate staff transactional education email can override a withheld Education × Email preference and records that cell ON after sending; a failed preference write reports `preferenceUpdate: "failed"` without reversing the sent result. Preference and consent-evidence routes use versioned Patient transactions; the evidence-gap report tracks missing evidence without gating sends. Call and mail preferences are recorded but have no automated sender. The preference screens are a separate delivery slice.
