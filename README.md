# Double Check

Solana custody where **no single key can move funds**.

- Live app (devnet): https://dupla.sjoel99.com
- Demo video (2:13, captions in English): [colosseum/double-check-demo.mp4](colosseum/double-check-demo.mp4)
- Leia em português: [README.pt-BR.md](README.pt-BR.md)

## The problem

A normal Solana wallet is one key. Whoever holds it owns the funds, so every way of losing or leaking that key is a total loss:

- **Seed phrase loss:** the device breaks or the backup is gone, and the funds are gone with it.
- **Phishing and drainers:** a fake site or a malicious dApp gets one signature, and that signature is enough.
- **Blind signing:** the wallet shows instructions the user cannot read, so the user approves whatever the site built.

## The solution

Funds live in the Vault of a [Squads v4](https://github.com/Squads-Protocol/v4) **2-of-3** multisig. Moving funds or changing a key always takes two independent votes, and execution is a separate permission held by a policy-checking operator. The guarantee comes from the Squads program itself: the backend, the database and the webapp can fail without any single key being able to move funds.

## How it works

### Three voters, one executor

| Member | Squads permission | Where it lives | What it can do alone |
|---|---|---|---|
| User's wallet | Vote | Phantom, Backpack, Solflare or any [Wallet Standard](https://github.com/wallet-standard/wallet-standard) wallet | nothing: 1 vote, cannot execute |
| Webapp key | Vote | Ed25519 key generated on the device, encrypted (AES-256-GCM) with a key derived from the passkey's WebAuthn **PRF** output; the service stores only the ciphertext | nothing: 1 vote, cannot execute |
| Service key | Vote | KMS/HSM (dev: encrypted file) | nothing: 1 vote. It only votes on **key changes, never on sends** |
| Service operator | Initiate + Execute | server | creates and executes what **already** has 2 votes; does not vote |

- Only the operator executes, and it does so only after checking the policy. Even with both of the user's votes, neither the wallet nor the webapp key can execute; this is proven against the real program.
- The account configuration is fixed and checked on-chain before every decision and after every key change: threshold 2, exactly these 3 voters with Vote only, the operator as the only member with Execute, no config authority, `time_lock = 0`, and the user's wallet as `rent_collector`.
- **The service holds no SOL.** Fees and rent are paid by the user's wallet.

### Sends: one atomic transaction

A send is a single Solana transaction:

```
[ vault_transaction_create(creator = operator, rent_payer = wallet, memo = dk1:<intent hash>)
  proposal_create(creator = operator, rent_payer = wallet)
  proposal_approve(wallet)
  proposal_approve(webapp key)
  vault_transaction_execute(member = operator)
  vault_transaction_accounts_close(rent_collector = wallet) ]
fee payer: wallet · signers: wallet, webapp key, operator
```

All or nothing: if execution fails, not even the proposal is left on-chain. The Squads account rent is charged and refunded within the same transaction.

### Key changes: 72 h delay and veto

Any of the three voters can be replaced. A change is one ConfigTransaction `[AddMember(new, Vote), RemoveMember(current)]` (plus `SetRentCollector(new)` when replacing the wallet), created by the operator and approved by two voters in the same transaction. A memo signed by the new key proves possession. Adding and removing in one transaction means the intermediate 4-voter state never exists on-chain.

The change then waits **72 hours**. During that window, whoever still holds the key being replaced can tap **"It wasn't me"** and veto it with a signed message. Because only the operator executes, the veto takes effect immediately, and a vetoed approved proposal goes stale at the next executed change (proven on-chain).

| Change | When | Votes on the request | Pays | Vetoes |
|---|---|---|---|---|
| Replace the wallet | wallet lost, seed leaked, or switching wallets | webapp key + service | the **new** wallet | the current wallet |
| Recover the webapp | device lost or replaced | wallet + service | the wallet | the current webapp key |
| Rotate the service key | scheduled rotation or compromise (admin) | wallet + service | the wallet | wallet or webapp key |

Squads v4 has a single, global `time_lock` that would also delay every send, so the delay is enforced by the operator, the only member with Execute. If the service is fully compromised the delay disappears, but the attacker still needs a second vote from the user.

### Recovery

- **Lost device:** the wallet + the service recover the webapp key on a new device (72 h, vetoable).
- **Lost wallet:** sign in with the passkey ("Lost your wallet? Sign in with biometrics"). The device discovers the passkey, fetches the encrypted copy from the service, opens the webapp key and signs in. The webapp key + the service then replace the wallet (72 h, vetoable).
- Passkeys synced by the password manager also open the webapp key on other devices.

### Email alerts

The 72 h window only protects users who hear about the request in time. The service sends email alerts (via the Resend HTTP API) for key-change requests (with the execution date and the "It wasn't me" path), vetoes and completed changes, executed sends, account configuration that does not match the model, and email changes.

- Registering or changing the alert address requires a signature from the **webapp key** plus a 6-digit code sent to the address (valid 10 min, one attempt, only its hash is stored). A leaked wallet seed can sign in but cannot redirect alerts. The old address is notified of a change.
- Emails contain no authorizing link and no secret; they only point to the Security screen, where everything is checked again.
- Without email, the pending change is still shown on the home screen.

## The flows

**Sign-up**
1. The webapp generates the webapp key and encrypts it with this device's passkey (PRF).
2. The service prepares the 2-of-3 account creation. The webapp verifies the transaction: only the creation, with the right members, nothing hidden.
3. The webapp key and the wallet sign the binding memo (proof of possession of both keys inside the transaction itself), and the wallet pays (~0.003 SOL).

**Send**
1. The user requests a send. The service checks the policy and simulates; nothing goes on-chain.
2. The webapp receives the atomic transaction, **rebuilds it on its own from what it displays, and compares byte-for-byte**. It reads the multisig through an RPC pinned at build time.
3. **Biometrics:** the passkey opens the webapp key, which signs those exact bytes. The service operator signs the execution, and only for messages it prepared itself, within the validity window, carrying a valid webapp key signature.
4. The wallet signs **once** and pays. If anything fails, nothing happens on Solana.

**Key change:** request (two votes) → 72 h → complete. Before that, "It wasn't me" cancels. See [docs/KEY_ROTATION.md](docs/KEY_ROTATION.md).

**Phone (QR + Mobile Wallet Adapter)**

The QR code on the computer opens **our webapp** on the phone. There it verifies the transaction and opens the webapp key with the phone's biometrics. It then calls the wallet through the Mobile Wallet Adapter (Android), which connects and signs in a single round-trip. The phone does not even need to sign in: the QR token grants access to that one transaction and to the encrypted copy of the key, and signing still requires biometrics + wallet.

**The "malicious server" demo**

In the send form, enable "Simular servidor malicioso" (simulate a malicious server). The server then displays 1/10 of the real amount. The webapp rebuilds the transaction from what it shows, sees that the bytes do not match, and displays **Transação bloqueada** (transaction blocked) with the real amount. This is the defense against transaction substitution and blind signing: the webapp key only signs bytes the webapp has rebuilt and matched.

## Costs

| | Cost to the user's wallet |
|---|---|
| Create the account (once) | ~0.003 SOL |
| Each send | 0.000015 SOL. At signing time the wallet must *hold* ~0.0065 SOL: the Squads account deposit is refunded in the same transaction |
| Key-change request | ~0.000015 SOL + ~0.006 SOL deposit, refunded on completion |
| Deposit into the Vault | 0.000005 SOL |
| Sign in | free (message signature) |

## What the tests prove

`pnpm test` runs against the Squads v4 ELF downloaded from **mainnet** (sha256 in `fixtures/ORIGEM.md`), loaded into **LiteSVM** with signature verification on. The attacker talks to the program directly, bypassing the backend. 76 tests, about 4 seconds, no network.

```
wallet alone = impossible                      (Test 1)
service alone = impossible                     (Test 2)
wallet + webapp key, operator executes = works (Test 3)
replacing the wallet needs two votes           (Tests 6, 8)
replacing the service key needs two votes      (Tests 7, 9)
create + approve + execute is atomic           (a failure leaves nothing on-chain)
the service spends no SOL                      (the wallet pays fee and rent; rent is refunded)
```

Also covered:
- the executor and the proposer cannot vote;
- the wallet cannot create Vault transactions;
- replay;
- expiration;
- proof of possession of the new key;
- swapping the new key after approval;
- a fully compromised backend;
- the app showing A while the chain has B;
- a tampered audit log.

The full invariant-to-test map is in [docs/SECURITY_INVARIANTS.md](docs/SECURITY_INVARIANTS.md).

## Quick start

```bash
pnpm install
pnpm test     # 76 tests, ~4 s, no network: mainnet Squads v4 running in LiteSVM
pnpm dev      # offline surfpool (Squads v4 from fixtures) + API :8787 + app :5173
```

Open **http://127.0.0.1:5173**. The UI text is in Portuguese for now; the labels below are given as they appear on screen, with a translation.

### 5-minute walkthrough

1. **Pick a wallet.** On localnet there are two **Carteiras de teste** (test wallets A and B) that mimic the wallet popup, and a **biometria de teste** (test biometrics) that mimics a fingerprint. The webapp requests test SOL, creates the webapp key (confirm the biometrics), and the wallet signs the account creation (~0.003 SOL).
2. **Deposit:** "10 SOL no Vault" (test tools) or **Depositar** (the wallet pays).
3. **Send:** address and amount → **Revisar** (Review) → check the "Conferido…" (Verified) summary → **Assinar** (Sign). The biometrics open the webapp key, the operator signs, and the wallet signs once. Under "Ou continuar no celular (QR)" (or continue on the phone), **Abrir no celular de teste** opens another tab that plays the phone.
4. **Malicious server:** tick "Simular servidor malicioso" and make another send. The server shows 1/10 of the amount; the webapp rebuilds the transaction, sees it does not match, and shows **Transação bloqueada** with the real amount.
5. **Recover the webapp:** Segurança (Security) → **Recuperar o webapp neste aparelho** (recover the webapp on this device). The biometrics create the new key and the wallet votes and pays. On localnet the delay is **2 minutes** (72 h on the hosted app). The home screen shows the pending change; after the delay, **Concluir troca** (complete change).
6. **It wasn't me:** request another recovery and tap **Não fui eu** ("It wasn't me"): the biometrics (current webapp key) veto it.
7. **Lost wallet:** Sair (sign out) → **Perdeu a carteira? Entrar com a biometria** (lost your wallet? sign in with biometrics) → Segurança → **Trocar a carteira** (replace the wallet) with test wallet B (which needs SOL).

### With a real wallet

Phantom and other Wallet Standard wallets appear in the list automatically. On localnet, signing messages and transactions works, but the wallet simulates the transaction on its own network (mainnet/devnet), where this account does not exist, so it may warn that it could not simulate. To avoid that, run on devnet: `SOLANA_RPC_URL=https://api.devnet.solana.com SOLANA_CLUSTER=devnet pnpm dev`, with devnet SOL in the wallet and the wallet set to devnet (or use `pnpm dev:devnet`).

When replacing the wallet with another account in the same wallet app, switch accounts between the steps: the new account signs the message and the current one signs the change. The app says which account must be active.

### Testing with your phone (devnet)

```bash
pnpm dev:devnet
```

This starts an HTTPS tunnel (cloudflared), because the phone and passkeys require HTTPS; a Postgres container with persistent keys; and points everything at devnet. Your wallet pays, so it needs devnet SOL (https://faucet.solana.com; 0.05 SOL covers many tests). In Phantom on the phone, enable devnet: Settings → Developer Settings → Testnet Mode → Solana Devnet. On the computer, open the tunnel URL the script prints (or http://localhost:5173; 127.0.0.1 does not work for passkeys).

Passkeys are bound to the domain and the tunnel URL changes on every run, so accounts created on one tunnel cannot open the webapp key on the next one (only through "Recuperar o webapp"). For phone testing, the hosted app at https://dupla.sjoel99.com has a fixed domain.

### Other commands

```bash
pnpm typecheck                     # packages, API and app
pnpm smoke                         # full flow over RPC (surfpool or devnet) without the app
pnpm fixtures                      # re-download the Squads ELF from mainnet
docker run -d --rm --name dk-pg -e POSTGRES_PASSWORD=dk -e POSTGRES_DB=dk -p 55432:5432 postgres:17-alpine
pnpm test:pg                       # whole protocol against a real Postgres
DATABASE_URL=postgres://... pnpm dev   # API persisting to Postgres
```

surfpool runs **offline** with the Squads v4 ELF loaded from fixtures. Without `DATABASE_URL`, everything is in memory: restarting `pnpm dev` wipes the accounts.

## Repository structure

```
apps/api               Fastify: sign-up/sign-in by signature, intents, wallet transaction, key changes
apps/approval-web      webapp (React; Wallet Standard; test wallets on localnet)
packages/shared        canonical intent (hash), schemas, errors
packages/crypto        Signer/ServerSigner, messages the wallet signs (binding, sign-in)
packages/solana        Chain (RPC | LiteSVM), instruction reader
packages/squads        on-chain state, builders, invariants, intent derivation
packages/policy-engine default policy
packages/custody       orchestration (server) and review + transaction rebuild (app)
packages/database      Postgres (PgStore) + migration
tests/                 on-chain, protocol, regressions, database
fixtures/              Squads v4 ELF and mainnet ProgramConfig
```

## Docs

The full text of these documents is in Portuguese.

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): members and permissions, the webapp key (passkey PRF → HKDF → AES-256-GCM), the atomic send step by step with its API endpoints, sign-up, key changes with delay and veto, the phone flow, and the security decisions (D1–D19).
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md): threats (stolen device, malware, leaked seed, compromised service or database, malicious RPC, phishing, transaction substitution, supply chain, tampered webapp, and more), each with impact, mitigation and residual risk.
- [docs/SECURITY_INVARIANTS.md](docs/SECURITY_INVARIANTS.md): the 8 security invariants, who enforces each one (program, operator, webapp, database) and which tests prove it, plus the 13 tests from the original specification mapped to the 2-of-3 model.
- [docs/KEY_ROTATION.md](docs/KEY_ROTATION.md): the three key changes, why add and remove happen in one transaction, why the delay is not on-chain, the state machine (PREPARED → PENDING → EXECUTED / VETOED / FAILED), residual risks and tests.
- [docs/RECOVERY.md](docs/RECOVERY.md): research note from the earlier 2-of-2 design on why pure Squads v4 cannot express a separate recovery rule (single threshold, global time lock), and the alternatives considered (Squads Smart Account policies, a custom `config_authority` program). The recovery shipped in this version is the 2-of-3 model with an operator-enforced delay described in ARCHITECTURE.md.
- [docs/RESEARCH.md](docs/RESEARCH.md): versions, Squads SDK APIs used, and the program behaviors that shape the design (permission bitmask, staleness, no on-chain expiration, global time lock, spending limits bypassing quorum), each tied to the program source and a test.

## Limitations of this version

- **Tampered webapp:** the webapp key is open in the browser while signing. Whoever controls the code the browser runs (a compromised service serving the webapp) can capture it; together with the service's vote, that is 2 votes. Hardening: host the webapp separately from the service. See THREAT_MODEL #31.
- **PRF required:** the device must provide the passkey PRF extension. Tested: Chrome on Android (fingerprint) and Chrome on desktop (Google Password Manager PIN). Test page at `/#/prf`.
- **Losing the wallet and every device** locks the account: that is both of the user's votes gone.
- **Email alerts** need `RESEND_API_KEY` and `DK_EMAIL_FROM`; without them, alerts only go to the log.
- **Mainnet is blocked:** the service keys are development keys; KMS/HSM is required first.
- **SOL transfers only.** Swaps and SPL tokens come later.
- **Mobile Wallet Adapter on Android only.**
- **iPhone is not supported yet:** the QR page opens, but there is no way to connect a wallet; the app shows a notice on the welcome screen and on the QR page.
