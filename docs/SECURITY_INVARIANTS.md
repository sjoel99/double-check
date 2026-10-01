# Invariantes de segurança

Modelo atual: CLIENT = carteira comum do cliente (Phantom, Backpack…, permissões Vote+Execute); SERVER = chave do serviço (Vote).

Cada invariante tem quem a garante e os testes que a provam. "Programa" = o ELF do Squads v4 da mainnet rodando no LiteSVM, com verificação de assinatura ligada: o atacante fala direto com ele, sem passar pelo backend.

| # | Invariante | Quem garante | Testes |
|---|---|---|---|
| 1 | Nenhuma private key isolada movimenta fundos | Programa (threshold 2, só CLIENT e SERVER votam) | `onchain` Testes 1, 2, 4, 5 |
| 2 | Nenhuma private key isolada consegue trocar os votantes | Programa (ConfigTransaction também exige 2 votos; sem config authority; `assertStrictTwoOfTwo`) | `onchain` Testes 6, 7, 8 (só CLIENT_A), 9 (sem o app) |
| 3 | O servidor não retira nem redireciona ativos sem o usuário | Programa (a carteira do cliente precisa votar) + app (conferência na chain antes de pedir a assinatura) | `protocol` "INVARIANTE 3 — backend inteiro comprometido"; `onchain` Teste 2 |
| 4 | O cliente não retira ativos sem a política/aprovação do servidor | Programa (a carteira não tem Initiate nem quórum) + PolicyEngine antes do voto do serviço | `protocol` "INVARIANTE 4"; `onchain` Teste 1; "PERIGO evitado" (por que a rotação é atômica) |
| 5 | A transação mostrada é exatamente a aprovada | App (`reviewOnChain` pela RPC fixada no build, nunca indicada pela API) + declaração com intentHash e hash da conta on-chain + voto montado no app | `protocol` "INVARIANTE 5", Teste 10, "voto não pode ser redirecionado" |
| 6 | Chave revogada nunca volta a ser válida | Programa (`NotAMember`) + backend (`REVOKED_KEY_REUSE`) + trigger no Postgres + sessão morre | `protocol` "INVARIANTE 6", Teste 8; `database` "trigger impede reativar"; `api` "sessão antiga morre" |
| 7 | Chave nova prova posse antes de entrar | Backend (`checkPossession`) + política (`NO_PROOF_OF_POSSESSION`) + app confere a prova (`verifyRotationProof`) | `protocol` Teste 13 (5 variações); `regressions` A4 |

## Os 13 testes pedidos

| Teste | Arquivo | Resultado esperado |
|---|---|---|
| 1. Só CLIENT_KEY move fundos | `tests/onchain.test.ts` | `InvalidProposalStatus` / `Unauthorized` |
| 2. Só SERVER_KEY | `tests/onchain.test.ts` | idem |
| 3. CLIENT + SERVER | `tests/onchain.test.ts` | executa; destino recebe |
| 4. Executor tenta votar | `tests/onchain.test.ts` | `Unauthorized` |
| 5. Proponente (wallet operacional) tenta votar | `tests/onchain.test.ts` | `Unauthorized` |
| 6. CLIENT comprometida remove SERVER | `tests/onchain.test.ts` | `InvalidProposalStatus`; servidor continua membro |
| 7. SERVER comprometida remove CLIENT | `tests/onchain.test.ts` | idem; threshold continua 2 |
| 8. Rotação CLIENT_A → CLIENT_B | `tests/onchain.test.ts`, `tests/protocol.test.ts` | só A: falha; A + SERVER: sucesso; A depois: `NotAMember` |
| 9. Rotação SERVER_A → SERVER_B | `tests/onchain.test.ts`, `tests/protocol.test.ts` | sem o app: falha (e expira com rejeição on-chain); com o app: sucesso |
| 10. Trocar a chave nova depois da aprovação | `tests/protocol.test.ts` | app recusa (`INTENT_MISMATCH`); backend recusa (`STATEMENT_MISMATCH`) |
| 11. Replay de aprovação | `tests/protocol.test.ts` | `INTENT_NOT_PENDING`, `STATEMENT_MISMATCH`, `REPLAY`; programa: `AlreadyApproved` |
| 12. Proposta expirada | `tests/protocol.test.ts` | app e backend recusam; proposta `Rejected` on-chain; voto direto: `InvalidProposalStatus` |
| 13. Chave nova sem prova de posse | `tests/protocol.test.ts` | `POSSESSION_BAD_SIGNATURE`, `_WRONG_CHALLENGE`, `_EXPIRED`, `_WRONG_OPERATION`; nada proposto |

## Como rodar

```bash
pnpm test        # 69 testes: on-chain (LiteSVM + ELF da mainnet), protocolo, regressões, política, banco, API
pnpm test:pg     # protocolo inteiro com Postgres real (precisa de um Postgres; ver README)
```

Uma verificação de mutação manual foi feita: removendo a checagem de nonce do backend, o teste "nonce de uso único" falha.
