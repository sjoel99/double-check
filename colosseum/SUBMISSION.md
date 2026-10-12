# Double Check: Colosseum submission (Crypto World's Fair, Solana track)

Ready to paste. Everything below comes from the repo (README.md, docs/*.md, package.json files, git log) or from facts Joel gave. Anything only Joel knows is marked `[JOEL: ...]`.

Checks before pasting:
- `pnpm test` run on 2026-10-12: **76 tests passed in 9 files, about 4 s, no network.** README, pitch and descriptions all say 76.
- Git history: 40 commits, from 2026-09-30 23:25 to 2026-10-04 15:35 (UTC-3).
- No user, revenue or traction numbers were invented. "Two external testers" is the only usage claim.

---

## 1. Name and descriptions

**Product name:** Double Check
**Optional English subtitle:** Double Check: two-key custody for Solana


### One-liner (140 chars)

> Solana custody where no single key can move your funds: your wallet plus a passkey-locked device key, with a 72h veto window on key changes.

### Short description (about 100 words)

> Double Check is self-custody on Solana where no single key can move funds. Assets sit in a Squads v4 2-of-3 vault. The three votes are your normal wallet (Phantom, Backpack, or any Wallet Standard wallet), a device key that only your passkey can unlock (WebAuthn PRF), and a service key that never votes on sends. A leaked seed phrase is not enough to drain you, and a lost phone or wallet can be recovered. Any key change waits 72 hours and can be vetoed with "It wasn't me". The service holds no SOL, and the user pays network fees. It is live on devnet at dupla.sjoel99.com.

### Long description (about 260 words)

> **The problem.** On Solana, one seed phrase or one bad signature can empty a wallet. Hardware wallets help, but most people never buy one. Multisigs are safer, but they were built for teams and DAOs, not for one person with a phone.
>
> **The insight.** One person already has two independent factors: the wallet they use every day and the device they carry, which can be unlocked with a passkey. With WebAuthn PRF, a passkey can produce a secret that unlocks a real Solana signing key. That key can then be a real vote in a multisig, not just a check in a backend.
>
> **What Double Check does.** Funds sit in a Squads v4 2-of-3 vault. The three voters are:
> - the user's wallet;
> - a "webapp key", encrypted on the device by the passkey (the server only stores ciphertext);
> - a service key that votes only on key changes, never on sends.
>
> Only the service's operator, which has no vote, can execute, and it checks a policy first. A send is one atomic transaction. The webapp rebuilds it and compares it byte by byte, the passkey signs, the operator signs, and the wallet signs once and pays. If anything fails, nothing lands on-chain.
>
> **Recovery without a backdoor.** If you lose your phone, your wallet plus the service restore the device key. If you lose your wallet, your passkey plus the service replace it. Every key change waits 72 hours, sends an email alert and can be vetoed by the key being replaced.
>
> **Proof.** 76 automated tests run against the actual Squads v4 program binary from mainnet (pinned by sha256) inside LiteSVM. The app is live on devnet, and external testers have used it. Mainnet is blocked until the service keys move to a KMS/HSM.

---

## 2. Blockchains and tools

**Blockchain:** Solana (devnet live; mainnet intentionally disabled in this version).

**On-chain program:** Squads Protocol v4 multisig (`SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`). There is no custom on-chain program. Security rests on Squads v4 permissions: Vote is separate from Initiate and Execute, threshold 2, no config authority, no spending limits.

**Solana libraries (versions from package.json):**
- `@sqds/multisig` 2.1.4 (Squads v4 SDK)
- `@solana/web3.js` ^1.99 (1.x, because the Squads SDK does not support `@solana/kit` yet)
- `@solana/spl-token` ^0.4.15 (dependency of the chain package; the product only moves SOL today)
- Wallet Standard: the webapp implements the `wallet-standard:register-wallet` / `app-ready` events directly, with no wrapper library. Tested with Phantom and Backpack.
- Solana Mobile Wallet Adapter: `@solana-mobile/mobile-wallet-adapter-protocol` 2.3.0 (Android; a QR code hands the operation to the phone)

**Testing and local chain:**
- LiteSVM 0.8.0, running the **mainnet Squads v4 ELF** (sha256-pinned in `fixtures/ORIGEM.md`) with signature verification on
- surfpool 1.1.2 for the local dev validator (offline, with the Squads v4 binary loaded from fixtures)
- Vitest 4 (76 tests: on-chain, atomic, protocol, regressions, database, alerts, policy)

**Backend:** Node.js + TypeScript, Fastify 5 (+ `@fastify/rate-limit`), Zod 4, PostgreSQL (`pg`) with an insert-only, hash-chained audit log; PGlite (`@electric-sql/pglite`) in tests.

**Frontend:** React 19 + Vite 8, WebCrypto.

**Cryptography:**
- WebAuthn passkeys with the **PRF extension**. The PRF output goes through HKDF to an AES-256-GCM key, which encrypts the Ed25519 seed of the device key.
- `@noble/curves`, `@noble/hashes`

**Alerts:** Resend HTTP API for email alerts on key-change requests, vetoes, executions and sends. The domain has SPF, DKIM and DMARC.

**Infrastructure:** Docker Compose, nginx, Cloudflare Tunnel, a VPS. pnpm monorepo (apps: `api`, `approval-web`; packages: `squads`, `solana`, `crypto`, `custody`, `policy-engine`, `database`, `shared`).

---

## 3. Go-to-market, demand validation, distribution

*Everything in this section is a hypothesis to test unless it says otherwise.*

**First customer segment (hypothesis):** Brazilian and Latin American individuals who hold a meaningful amount of SOL in a self-custody wallet. They already use Phantom or Backpack and are afraid of losing a seed phrase or signing a drainer transaction, but they will not buy or carry a hardware wallet. They are on Android with Chrome, the setup that is tested today. `[JOEL: one line on why you understand this user, e.g. you hold and manage SOL yourself]`

**Second segment (hypothesis):** Wallets, exchanges and fintechs that want to offer "safe mode" or co-signed accounts without building custody themselves. They would integrate Double Check as the co-signing service (white-label or API).

**Business model options (hypotheses, not validated):**
1. **Per-account subscription** for the service vote, policy checks and alerts (for example a small monthly fee). It is simple and fits a security product, since there is no incentive to push volume.
2. **Small fee per send**, added to the atomic transaction the user already pays for. It needs no billing setup but scales with usage, not with safety.
3. **B2B licence / per-account fee** for wallets and fintechs that integrate the co-signer.

Right now the service holds no SOL and pays nothing. The user pays network fees: about 0.003 SOL to create an account and 0.000015 SOL per send. Gross margin on the service side is mostly infrastructure plus KMS/HSM.

**Demand validation so far (facts only):**
- Live on devnet at https://dupla.sjoel99.com since early October 2026.
- External testers since 2026-10-03. One tester with Backpack on Windows created an account and sent funds without help. One iPhone user opened the QR but could not connect a wallet (iPhone is not supported yet). Feedback from testers led to concrete fixes, for example signing with the passkey before preparing the transaction because a 79-second delay expired the blockhash.
- Passkey PRF works on real devices with Chrome desktop and Chrome Android.
- `[JOEL: add any conversations, waitlist sign-ups or messages from potential users, only if they are real]`

**Next validation steps (plan):**
- 15–20 short interviews with SOL holders in Brazilian Solana communities. The question: "Would you move part of your SOL into a vault that needs two of your keys? What would you pay?"
- A waitlist on the landing page. Measure sign-up rate and how many people create a devnet account.
- Talk to 3–5 wallets or fintechs about the co-signer API.

**Distribution (plan):**
- Portuguese-first content: short videos showing "your seed leaked, and your funds are still safe", posted in Brazilian Solana communities `[JOEL: name the ones you are actually in, e.g. Superteam Brazil]`.
- Squads ecosystem visibility (built entirely on Squads v4).
- Wallet partnerships as a later channel. None exists today.

**Before mainnet (known gaps, stated openly):** service keys in a KMS/HSM; hosting the webapp separately from the service, with a reproducible build (threat model #31); iPhone support; SPL tokens; a legal review of whether co-signing counts as custody under Brazilian rules for crypto service providers.

---

## 4. Pre-existing work disclosure

> All code in https://github.com/sjoel99/double-check was written during the hackathon. The repository has 40 commits, from 2026-09-30 to 2026-10-04 (UTC-3), all inside the Sep 14 – Oct 12 window. Earlier iterations of the design (a 2-of-2 model, then the current 2-of-3 model) are part of that same history.
>
> Third-party components used as-is: the Squads Protocol v4 multisig program and its SDK (`@sqds/multisig`). The mainnet Squads v4 program binary is included in `fixtures/` for testing (sha256 recorded). Other components are open-source libraries listed in package.json.
>
> I have a separate, earlier personal project ("cofre", a multisig app on Squads v4 + Kamino). It is a different codebase and not part of this submission. `[JOEL: confirm that no code was copied from cofre; if any was, name the files here]`

---

## 5. Pitch video script (target 2:30, about 330 words)

*Read slowly. One sentence per breath. Show the screen in brackets.*

**[0:00–0:20] Hook / problem**
[Joel on camera]
Hi, I'm Joel, from Brazil. `[JOEL: one short line about your background]`
On Solana, one seed phrase controls everything.
If it leaks, or if you sign one bad transaction, your money is gone.
In 2024, private key compromises were the largest cause of stolen crypto: 43.8%, according to Chainalysis.

**[0:20–0:45] Insight**
Hardware wallets help, but most people never buy one.
Multisigs are safer, but they were built for teams, not for one person.
My insight is simple. You already have two keys.
Your wallet is one. Your phone, with its passkey, is the other.
Today, a passkey can unlock a real Solana key. So your phone can be a real vote.

**[0:45–1:20] Solution**
[Screen: home, then send flow]
This is Double Check.
Your funds sit in a Squads 2-of-3 vault.
Vote one is your normal wallet, like Phantom or Backpack.
Vote two is a device key, unlocked by your fingerprint.
Vote three is our service. It never votes on sends.
To send, you confirm with your fingerprint, and your wallet signs once.
It is one atomic transaction. If anything fails, nothing happens.
If your seed leaks, the attacker still cannot move your funds.

**[1:20–1:45] Recovery**
[Screen: Security page, pending change, "It wasn't me"]
Lost your phone? Your wallet and our service restore it.
Lost your wallet? Your fingerprint and our service replace it.
Every key change waits 72 hours.
You get an email, and you can press "It wasn't me" to cancel it.

**[1:45–2:05] Why Solana, why now**
This is possible now because of three things.
Squads v4 is already live on Solana mainnet.
Passkeys with PRF now work in Chrome, on desktop and on Android.
And Mobile Wallet Adapter connects the phone wallet in one step.

**[2:05–2:20] Proof**
[Screen: terminal, tests passing]
I built this in five days.
76 tests run against the real Squads program binary from mainnet.
It is live on devnet, and an outside tester already created an account and sent funds with Backpack.

**[2:20–2:30] Business and ask**
First users: SOL holders in Brazil who fear losing their seed.
The model is a small subscription or a fee per send. We will test both.
I'm looking for feedback, early users, and wallet partners.
Thank you.

*(Source for the statistic: Chainalysis, "$2.2 Billion Stolen in 2024", https://www.chainalysis.com/blog/crypto-hacking-stolen-funds-2025/ — "Private key compromises accounted for the largest share of stolen crypto in 2024, at 43.8%." Note that this figure is mostly about hacks of platforms, not individuals. If you prefer a number about individuals, use Scam Sniffer's: wallet drainers took about $494 million from about 332,000 addresses in 2024, but **on EVM chains only**: https://drops.scamsniffer.io/scam-sniffer-2024-web3-phishing-attacks-wallet-drainers-drain-494-million/ . If you are unsure, say instead: "Every week, people lose their crypto to leaked seeds and fake transactions.")*

---

## 6. Roteiro do pitch em português (tradução linha a linha)

**[0:00–0:20] Gancho / problema**
Oi, eu sou o Joel, do Brasil. `[JOEL: uma frase curta sobre sua experiência]`
Na Solana, uma frase-semente controla tudo.
Se ela vaza, ou se você assina uma transação ruim, seu dinheiro some.
Em 2024, o comprometimento de chaves privadas foi a maior causa de cripto roubada: 43,8%, segundo a Chainalysis.

**[0:20–0:45] Insight**
Carteiras de hardware ajudam, mas a maioria das pessoas nunca compra uma.
Multisigs são mais seguras, mas foram feitas para equipes, não para uma pessoa.
Meu insight é simples. Você já tem duas chaves.
Sua carteira é uma. Seu celular, com a passkey, é a outra.
Hoje, uma passkey consegue destravar uma chave Solana de verdade. Então seu celular pode ser um voto de verdade.

**[0:45–1:20] Solução**
[Tela: início, depois o fluxo de envio]
Este é o Double Check.
Seus fundos ficam num cofre 2 de 3 da Squads.
O voto um é sua carteira normal, como Phantom ou Backpack.
O voto dois é uma chave do aparelho, destravada pela sua digital.
O voto três é o nosso serviço. Ele nunca vota em envios.
Para enviar, você confirma com a digital, e sua carteira assina uma vez.
É uma transação atômica. Se algo falhar, nada acontece.
Se sua seed vazar, o atacante ainda não consegue mover seus fundos.

**[1:20–1:45] Recuperação**
[Tela: página Segurança, troca pendente, "Não fui eu"]
Perdeu o celular? Sua carteira e o nosso serviço recuperam.
Perdeu a carteira? Sua digital e o nosso serviço trocam a carteira.
Toda troca de chave espera 72 horas.
Você recebe um e-mail e pode apertar "Não fui eu" para cancelar.

**[1:45–2:05] Por que Solana, por que agora**
Isso é possível agora por causa de três coisas.
A Squads v4 já está no ar na mainnet da Solana.
Passkeys com PRF agora funcionam no Chrome, no computador e no Android.
E o Mobile Wallet Adapter conecta a carteira do celular em um passo.

**[2:05–2:20] Prova**
[Tela: terminal, testes passando]
Eu construí isso em cinco dias.
76 testes rodam contra o binário real do programa da Squads, da mainnet.
Está no ar na devnet, e um testador de fora já criou conta e enviou fundos com a Backpack.

**[2:20–2:30] Negócio e pedido**
Primeiros usuários: quem tem SOL no Brasil e tem medo de perder a seed.
O modelo é uma assinatura pequena ou uma taxa por envio. Vamos testar os dois.
Estou buscando feedback, primeiros usuários e carteiras parceiras.
Obrigado.

*(Nota: se preferir não citar número, troque a frase da Chainalysis por: "Toda semana, pessoas perdem cripto por seeds vazadas e transações falsas." / "Every week, people lose their crypto to leaked seeds and fake transactions.")*

---

## Other form fields (to fill)

- **Teammates:** `[JOEL: solo founder? name, role, one line of background, links (GitHub sjoel99, X, LinkedIn)]`
- **Location:** Brazil, `[JOEL: city/state]`
- **Logo:** [logo.png](logo.png) (512×512)
- **GitHub:** https://github.com/sjoel99/double-check (public)
- **Live demo:** https://dupla.sjoel99.com (devnet; Android + Chrome or desktop Chrome; iPhone not supported yet)
- **Pitch video (2–3 min):** script above. `[JOEL: link after upload]`
- **Demo video (2:13):** https://cdn.jsdelivr.net/gh/sjoel99/double-check@ca4ad1eef3b14d540359cab1605a323835638ab6/colosseum/double-check-demo.mp4 (recorded by [record-demo.cjs](record-demo.cjs) against the local app)
