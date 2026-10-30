# Security policy

Double Check is custody software. Bugs here can cost people money, so please
report them privately and give us time to fix them before any disclosure.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:
**Security → Report a vulnerability** on this repository
(https://github.com/sjoel99/double-check/security/advisories/new).

Please include what you found, how to reproduce it, and which invariant in
[docs/SECURITY_INVARIANTS.md](docs/SECURITY_INVARIANTS.md) or threat in
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) it affects, if any.

What to expect: an acknowledgement within 72 hours, a fix or a plan within
14 days for anything that lets a single key move funds or bypass the 72-hour
key-change delay, and credit in the fix commit if you want it.

## Scope

- The code in this repository: API, webapp and shared packages.
- The deployment at https://dupla.sjoel99.com (devnet only; it holds no real funds).

Out of scope: the Squads v4 program itself (report to Squads Protocol), wallet
extensions and apps, and denial of service against the devnet deployment.

## Current status

This version runs on devnet only. Mainnet is disabled in the configuration
because the service keys are development keys without a KMS/HSM. The known
limitations are listed in the README under "Limitations of this version".
