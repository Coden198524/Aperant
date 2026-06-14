# Privacy And Support Policy

Version: 2026-06-14

This guide records the commercial v1 privacy and support posture for the desktop app. It is release evidence for a local Windows candidate, not a substitute for product/legal approval.

## Data Posture

Autocode is a local desktop application. Project files, task logs, local memory data, provider credentials, terminal output, and generated artifacts can contain sensitive information. Commercial v1 must treat these as user-controlled data and avoid silent external collection.

## Telemetry Policy

- Default telemetry posture: disabled unless a future release adds an explicit opt-in setting.
- No analytics, crash reports, prompt transcripts, memory records, task logs, source files, terminal output, or provider responses may be uploaded by default.
- If telemetry is added later, it must be documented, opt-in, revocable, and covered by a versioned privacy notice before commercial release.

## Logs And Crash Data

- Logs are local diagnostic artifacts unless the user intentionally shares them with support.
- Logs may include file paths, project names, command output, model/provider errors, and excerpts of task execution state.
- Support instructions must tell users to review or redact logs before sharing.
- Crash diagnostics must not be uploaded automatically in commercial v1.
- Any future automatic crash reporting must include opt-in consent, retention limits, and redaction guidance.

## Credentials And Provider Data

- Provider credentials must be stored through the app's configured credential/account mechanisms and must not be written to support bundles.
- Support workflows must avoid requesting raw API keys, OAuth tokens, session cookies, or private repository credentials.
- Provider usage, billing, model availability, and data retention remain governed by the selected provider's terms.

## Support Process

Commercial v1 support triage should ask for:

- App version and operating system.
- Reproduction steps.
- Sanitized screenshots when useful.
- Sanitized logs or task artifacts only after the user reviews them.
- Provider name and model ID without credentials.

Support should not ask for:

- Raw provider API keys or OAuth tokens.
- Full private repositories unless a separate support agreement exists.
- Unredacted logs containing secrets, proprietary source, or personal data.

## Manual Approval Required

Before external commercial release, a product owner must approve:

- Public privacy/support copy.
- Telemetry default and any opt-in wording.
- Log and crash diagnostic handling.
- Support channel, response expectation, and data handling process.
- Retention policy for support attachments.

Until that approval is recorded, `privacy-support` remains a commercial-ready blocker.
