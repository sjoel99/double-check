# Invariantes de segurança

**Modelo 2 de 3:**
- votam a Phantom (CLIENT), a chave do webapp (WEBAPP, destravada pela biometria) e o serviço (SERVER);
- só o operador do serviço (OPERATOR) cria e executa;
- operações atômicas, pagas pela Phantom.

"Programa" é o ELF do Squads v4 da mainnet rodando no LiteSVM, com verificação de assinatura ligada: o atacante fala direto com ele, sem passar pelo backend.

| # | Invariante | Quem garante | Testes |
|---|---|---|---|
| 1 | Nenhuma chave isolada movimenta fundos | Programa (threshold 2; o operador não vota; votantes não executam) | `onchain` Testes 1, 2, 4/5 |
| 2 | Nenhuma chave isolada troca os votantes | Programa (ConfigTransaction exige 2 votos; sem config authority) | `onchain` Testes 6, 7 |
| 3 | O serviço não retira fundos sem o usuário | Programa (1 voto do serviço + operador não bastam) + o serviço nunca vota em envios | `protocol` "INVARIANTE 3"; `onchain` Teste 2 |
| 4 | O usuário não retira fundos sem a política do serviço | Programa: com os dois votos do usuário, nem a Phantom nem o webapp executam; só o operador, depois de conferir | `onchain` "NOVO — … só o operador"; `atomic` "Phantom no lugar do operador" |
| 5 | A transação mostrada é a que a carteira assina | Webapp remonta e compara os bytes (RPC fixada no build); a chave do webapp assina esses bytes; o operador só assina mensagens preparadas | `protocol` "INVARIANTE 5", "o operador só assina…"; `regressions` A4 |
| 6 | Chave revogada nunca volta | Programa (`NotAMember`) + backend (`KEY_REVOKED`/`REVOKED_KEY_REUSE`) + trigger no Postgres | `protocol` "trocar a Phantom" (INVARIANTE 6); `database` |
| 7 | Chave nova prova posse antes de entrar | Memo assinado pela chave nova na transação do pedido; Phantom e webapp assinam o memo do cadastro | `protocol` cadastro e trocas |
| 8 | Toda troca de votante leva 72 h e pode ser vetada | Operador único executor + `executeAfter`; veto pela chave que seria trocada | `protocol` trocas; `onchain` "Não fui eu", "stale" |

## Os 13 testes do pedido original, no modelo 2 de 3

| Teste | Onde | Resultado |
|---|---|---|
| 1. Só a Phantom | `onchain` | `InvalidProposalStatus` |
| 2. Só o serviço (voto + operador) | `onchain` | `InvalidProposalStatus`; operador não vota |
| 3. Phantom + webapp, operador executa | `onchain`, `atomic`, `protocol` | executa |
| 4/5. Operador vota / Phantom cria | `onchain` | `Unauthorized` |
| 6. Phantom remove o serviço | `onchain` | `InvalidProposalStatus` |
| 7. Serviço remove a Phantom / baixa o threshold | `onchain` | `InvalidProposalStatus` |
| 8. Trocar a Phantom | `onchain`, `protocol` | webapp + serviço; operador executa depois do prazo; a antiga recebe `NotAMember` |
| 9. Trocar o serviço / recuperar o webapp | `onchain`, `protocol` | Phantom + serviço; prazo; operador executa |
| 10. Trocar o conteúdo depois de aprovado | `protocol`, `regressions` | webapp recusa (`INTENT_MISMATCH`); operador recusa (`TX_NOT_EXPECTED`) |
| 11. Replay | `protocol` | `INTENT_NOT_PENDING` |
| 12. Proposta expirada | `protocol`, `regressions` | `INTENT_EXPIRED`; transação preparada vence com o blockhash |
| 13. Chave nova sem prova de posse | `protocol` | cadastro sem a assinatura do webapp: `WEBAPP_BAD_SIGNATURE` |

## Como rodar

```bash
pnpm test        # on-chain (LiteSVM + ELF da mainnet), atômica, protocolo, regressões, banco, API
pnpm test:pg     # protocolo com Postgres real
```
