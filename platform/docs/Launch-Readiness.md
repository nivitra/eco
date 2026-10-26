# Kulture launch readiness

Updated 26 October 2026. This is the state of the combined console and platform checkout in `D:\kulture_web`; it is not a claim that a public production deployment exists.

## Find & Claim

- The console searches existing catalog branches, orders closer name matches first, and can load further pages. If there is no match, an owner can submit a new branch with a structured Indian address and ownership evidence.
- An existing branch claim and a new branch submission enter an operator review queue. A submitted claim does not unlock publication. The operator must verify authority for the exact physical branch and record a reason before approving. Do not approve based only on the submitter's text.
- Claims need a real owner account and workspace. For a specific business, obtain the exact public name, full address and city, business website or other public reference, and a way to independently verify the claimant's authority. Do not send private identity documents through chat; use a controlled intake process if they are needed.
- Current bundled catalog coverage is limited. A missing search result does not imply the business does not exist. New branch submissions need duplicate review.

## Verified in this checkout

- Backend and console production image builds. The Linux image build runs 13 console unit tests; all passed.
- Backend integration tests passed against a disposable database for account, tenant, claim submission, rejection of merchant self-approval, operator approval, draft and publish. The disposable database was removed afterward.
- Local API smoke checks passed for readiness, search pagination without repeated IDs, and exact-name-first ordering.
- Backend and frontend dependency audits returned zero known advisories after patch updates. Repeat audits before release because advisories change.
- The local stack is at `http://localhost:3000/console/`. The local Compose override binds ports to loopback. Authentication and ownership review must stay enabled for public use.

## Inputs needed from the project owner

1. **Business to onboard:** exact name, branch address and city, public website or listing, and the authorized person's contact method. Choose who will review proof of ownership and disputes. Add those reviewers' account IDs to the private `ADMIN_USER_IDS` server setting. This is required to complete a real claim safely.
2. **Public host:** production domain and DNS control, plus an x86-64 Linux VPS or approved hosting account with Docker Compose, persistent SSD storage, and ports 80/443 available. Provide deployment access through a secure channel, not a password pasted into chat.
3. **Account email:** a transactional SMTP provider, verified sender domain/address and access to its configuration. Confirm the contact/support email and password reset policy. Test delivery and bounce handling before inviting users.
4. **Business policy:** legal entity, privacy policy, terms, support and abuse contacts, evidence retention policy, and named operators for claim review and incident response. Review applicable legal obligations with counsel for the launch markets.
5. **Payments, if charging at launch:** activated Razorpay merchant account, the intended INR plan, webhook configuration, refund/cancellation policy and reconciliation owner. Keep checkout disabled until real payment and failure paths are tested.
6. **Optional integrations:** Mapbox public token for maps, an operated routing provider, and AI provider credentials if those features are promised. The WordPress adapter source is absent; provide it or exclude WordPress delivery from launch scope. These are separate from the hosted business site.

Keep credentials in the private server environment or an approved secrets manager. Do not commit them or paste them into issues/chat.

## Remaining release gates

- Review and commit the combined console and platform source together, run the checked-in CI workflow on GitHub, and verify clean deployment from a reviewed commit.
- Configure public DNS and HTTPS; validate Caddy, the API, worker, persistent volumes, migrations and sign-in on the actual production host. Do not deploy either local Compose override to the public host.
- Run account creation, email verification/reset, search, claim, new branch, operator approval/rejection, edits, preview, publish and withdrawal on a staging copy with representative data. Confirm the reviewed public output and mobile layouts in a real browser. The in-app browser was unavailable for this local session, so visual end-to-end verification remains open.
- Set up encrypted off-host backups for database, media and separate secrets, then complete a restore drill. Monitor readiness, worker heartbeat, disk, failed jobs and payment events. Define an incident owner and rollback procedure.
- Perform a security and accessibility review, rate-limit/abuse review, privacy review and load test against expected traffic. A successful build and integration test do not establish these production properties.

The [operations runbook](Operations-Runbook.md) contains the backup, recovery and operator commands. The [merchant API](Merchant-API.md) describes claim and publication states.
