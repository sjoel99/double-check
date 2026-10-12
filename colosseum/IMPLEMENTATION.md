# Double Check — Implementation details (Colosseum)

Oct 12, 2026 · @Joel Santos

## Frontend/framework

React 19.3 single-page app built with Vite 8.3 and TypeScript 5.9, no UI framework or wallet-adapter library (`apps/approval-web`).

- **UI:** React 19.3.0 + React DOM, hand-written CSS, hash routing.
- **Build:** Vite 8.3.1, `@vitejs/plugin-react` 6.1.1, `vite-plugin-node-polyfills` (Buffer for the Solana libraries).
- **Wallets:** Wallet Standard wired by hand (Phantom, Backpack, Solflare and any compliant wallet show up on their own); Android phones via Mobile Wallet Adapter (see the Solana section).
- **Device key:** WebAuthn passkey with the **PRF** extension. Its output goes through HKDF-SHA-256 to an AES-256-GCM key (WebCrypto) that encrypts the Ed25519 "webapp key". Signing uses `@noble/curves` 2.4.0.
- **QR hand-off to the phone:** `qrcode` 1.5.4.
- **Backend (`apps/api`):** Fastify 5.12.5 + `@fastify/rate-limit` 11.2.0, Zod 4.6.5 schemas, Node.js 24, Postgres 17 through `pg` 8.23 (PGlite 0.5.8 in local dev).
- **Monorepo:** pnpm 10.33 workspaces with shared packages (`shared`, `crypto`, `solana`, `squads`, `policy-engine`, `custody`, `database`).

## Solana SDK/client

`@solana/web3.js` 1.99.0 plus the official Squads SDK `@sqds/multisig` 2.1.4, on the unmodified Squads v4 program (`SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`).

- **Multisig:** Squads v4 2-of-3. We build `multisigCreateV2`, `vaultTransactionCreate`, `proposalCreate`, `proposalApprove`, `vaultTransactionExecute`, `vaultTransactionAccountsClose` and config transactions (AddMember / RemoveMember / SetRentCollector) with the SDK, then pack a whole send into one atomic transaction.
- **Why web3.js 1.x and not Kit:** the Squads SDK is built on web3.js 1.x.
- **Wallet connection:** Wallet Standard (`solana:signTransaction`, `solana:signMessage`), integrated by hand.
- **Mobile:** `@solana-mobile/mobile-wallet-adapter-protocol` 2.3.0, calling `transact` directly so the phone wallet connects and signs in a single session (Android).
- **Keys and hashing:** `@noble/curves` 2.4.0 (Ed25519) and `@noble/hashes` 2.4.0 (SHA-256 intent hashes); `bs58` 6.
- **On-chain checks:** the webapp reads the multisig state and rebuilds every transaction from what it shows the user, comparing it byte for byte with the server's version before any signature.

## RPC provider and hosting

The public Solana devnet RPC (`https://api.devnet.solana.com`), with no paid provider yet. The app is self-hosted on one VPS behind a Cloudflare Tunnel at https://dupla.sjoel99.com.

- **RPC:** the API talks to devnet directly. The browser goes through an nginx `/rpc` proxy on the same origin, which strips the Cloudflare headers that the public devnet RPC rejects. The RPC URLs are configurable (`SOLANA_RPC_URL`, `VITE_RPC_URL`, plus an optional second independent RPC, `VITE_RPC_URL_2`, for cross-checking reads).
- **Local:** surfpool 1.1.2 in offline mode, with the mainnet Squads v4 program loaded from fixtures.
- **Hosting:** a Contabo VPS running Docker Compose with three containers: nginx 1.29-alpine (static webapp, `/api`, `/rpc`), the API on `node:24-slim`, and Postgres 17-alpine on an internal-only network.
- **Network edge:** Cloudflare Tunnel (`cloudflared`), so the app's containers publish no ports on the VPS.
- **Email alerts:** Resend, from a verified domain with DKIM, SPF and DMARC.
- **Service keys:** encrypted files on the VPS for devnet. Mainnet is blocked until they move to a KMS/HSM.

## Testing/developer tools

Vitest 4.1 + LiteSVM 0.8.0: 76 tests in 9 files run in about 4 s, with no network, against the Squads v4 program binary downloaded from mainnet (sha256 recorded in `fixtures/ORIGEM.md`).

- **On-chain tests:** LiteSVM loads the mainnet Squads v4 ELF and its ProgramConfig account. The tests prove that the wallet alone, the service alone and the operator alone cannot move funds; that sends are atomic; that key changes need two votes; and that the backend cannot slip in a different transaction.
- **Local chain:** surfpool 1.1.2, offline, with the same fixtures, for `pnpm dev` and the end-to-end smoke test `pnpm smoke`.
- **Database:** PGlite 0.5.8 (in-process Postgres) for dev and tests, plus `pnpm test:pg`, which runs the whole protocol on a real Postgres 17 in Docker.
- **Type safety:** TypeScript 5.9 strict, `pnpm typecheck` across packages, API and webapp; `tsx` 4 runs scripts.
- **Local stand-ins:** two test wallets that mimic a wallet popup and a software passkey, so the full flow runs without devices. A `/#/prf` page tests passkey PRF on real phones.
- **Browser automation:** Playwright with Chrome, for screen checks and the recorded demo (`colosseum/record-demo.cjs`).
- **Real devices:** PRF verified on Chrome desktop and Chrome Android. An outside tester created an account and sent funds with Backpack on Windows.

## AI tools used in building the product

Claude Code (Anthropic), running Claude Opus 5.5, was the coding agent throughout: every commit in the repository carries its co-author trailer. The product itself uses no AI at runtime.

- **What it did:** wrote and refactored code across the monorepo, wrote and ran the LiteSVM tests, drafted the docs (architecture, threat model, invariants), drove Playwright for screen checks, and recorded the demo video.
- **What the founder did:** chose the custody model and every security trade-off (2-of-3 membership, operator-only execution, 72 h delay with veto, passkey PRF), tested on real devices, ran the external testers, and reviewed the changes.
- **Open question:** were any other AI tools used (for example Codex or ChatGPT for reviews)? If so, add them here.
