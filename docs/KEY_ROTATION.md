# Rotação de chaves

Duas rotações: a do cliente (trocar de aparelho, ou chave comprometida mas ainda disponível) e a do servidor (rotação programada ou chave do servidor comprometida). As duas exigem **CLIENT atual + SERVER atual** e são uma única ConfigTransaction `[AddMember(nova, só Vote), RemoveMember(antiga)]`.

## Regra fundamental

Comprometimento ≠ perda.

- **Chave comprometida, mas ainda disponível**: o atacante tem 1 de 2 votos e não alcança o threshold; o dono legítimo ainda tem a chave e, junto com o outro lado, troca a chave comprometida. Testes 6 e 7 mostram que o atacante sozinho não remove o outro membro; testes 8 e 9 mostram a troca legítima.
- **Chave perdida**: no modo `STRICT_2_OF_2`, perder de vez uma das duas chaves é **bloqueio permanente** — ninguém alcança o threshold para removê-la. Isso é intencional nesta fase; a saída está em RECOVERY.md. Não existe chave mestra, bypass de admin nem threshold 1 temporário.

## Por que uma transação só

O pedido original previa adicionar a nova chave, confirmar, e só depois remover a antiga. Entre um passo e outro a multisig teria 3 votantes com threshold 2 — e CLIENT_A + CLIENT_B, os dois do lado do usuário, moveriam fundos sem o servidor. O teste `PERIGO evitado` reproduz isso no programa real. Com as duas ações na mesma ConfigTransaction, o programa aplica as duas e só depois verifica o invariant: o estado de três votantes nunca existe na chain.

## Máquina de estados

```
REQUESTED ──► NEW_KEY_VERIFIED ──► OPERATIONS_FROZEN ──► AWAITING_CLIENT_APPROVAL
                                                               │
                                                               ▼
COMPLETED ◄── VERIFIED ◄── EXECUTING ◄── AWAITING_SERVER_APPROVAL

saídas: REJECTED · EXPIRED · FAILED · ROLLBACK_REQUIRED
```

| Estado | Significado | Sai para |
|---|---|---|
| REQUESTED | pedido criado; desafio emitido para a chave nova | NEW_KEY_VERIFIED, REJECTED, EXPIRED, FAILED |
| NEW_KEY_VERIFIED | a chave nova assinou o desafio (prova de posse) | OPERATIONS_FROZEN, EXPIRED, FAILED |
| OPERATIONS_FROZEN | conta congelada; fila drenada | AWAITING_CLIENT_APPROVAL, FAILED, ROLLBACK_REQUIRED |
| AWAITING_CLIENT_APPROVAL | ConfigTransaction criada; esperando o app | AWAITING_SERVER_APPROVAL, REJECTED, EXPIRED, FAILED |
| AWAITING_SERVER_APPROVAL | voto do cliente na chain; política do servidor | EXECUTING, REJECTED, EXPIRED, FAILED |
| EXECUTING | executor rodando a ConfigTransaction | VERIFIED, FAILED, ROLLBACK_REQUIRED |
| VERIFIED | `assertStrictTwoOfTwo` passou com os papéis novos, lido da chain | COMPLETED, ROLLBACK_REQUIRED |
| COMPLETED | chave antiga REVOGADA, papéis atualizados, conta descongelada | — |
| REJECTED / EXPIRED / FAILED | encerrada; proposta rejeitada on-chain se ainda ativa; conta descongelada | — |
| ROLLBACK_REQUIRED | estado inesperado (ex.: aprovada pendente na fila); exige ação humana | — |

Qualquer transição fora da tabela lança `ROTATION_BAD_TRANSITION` (`ROTATION_TRANSITIONS` em `packages/custody/src/service.ts`). `ADDING_NEW_MEMBER` e `REMOVING_OLD_MEMBER`, do pedido original, viraram `EXECUTING`, porque as duas coisas acontecem na mesma instrução.

## Passos (cliente: CLIENT_A → CLIENT_B)

1. **Pedido** — o app atual (CLIENT_A, com sessão) chama `POST /v1/accounts/:id/rotations/client`. O backend confere a multisig na chain, recusa se já houver rotação aberta, cria a rotação e um desafio de 32 bytes.
2. **Pareamento** — o app atual mostra um QR/link com `rotationId + challenge`. Quem tem esse código consegue só *pedir* para entrar; a troca ainda depende da aprovação do CLIENT_A.
3. **Prova de posse** — o aparelho novo gera CLIENT_B localmente e assina a declaração:
   ```json
   { "domain": "duplachave/possession/v1", "operation": "ROTATE_CLIENT_KEY", "cluster": "…",
     "multisig": "…", "rotationId": "…", "newPublicKey": "CLIENT_B", "challenge": "…",
     "nonce": "…", "createdAt": 0, "expiresAt": 0 }
   ```
   O backend confere operação, cluster, multisig, rotação, desafio, validade, assinatura **pela própria chave declarada**, nonce de uso único, que a chave não é membro e que **nunca foi revogada**. Sem isso, alguém cadastraria uma chave pública sem ter a privada (teste 13).
4. **Congelar e drenar** — a conta para de aceitar intenções novas (`OPERATIONS_FROZEN`). Para cada índice desde o último stale: proposta ativa → servidor rejeita (um voto basta); proposta **aprovada e não executada** → para em `ROLLBACK_REQUIRED` (ela sobreviveria à rotação).
5. **Proposta** — ConfigTransaction `[AddMember(CLIENT_B, Vote), RemoveMember(CLIENT_A)]` criada pelo PROPOSER, com intenção `ROTATE_MEMBER` (hash canônico). O backend relê a conta e confere que é a rotação esperada.
6. **Aprovação do cliente** — o app de CLIENT_A lê a ConfigTransaction pela RPC dele, confirma que troca exatamente CLIENT_A por CLIENT_B, mostra "Substituir chave de aprovação?", pede biometria/PIN e assina declaração + voto. CLIENT_B não consegue aprovar a própria entrada: ainda não é membro.
7. **Aprovação do servidor** — política: única forma aceita é a rotação, chave nova com posse provada nesta rotação, não revogada. O servidor vota.
8. **Execução e verificação** — executor executa; o backend relê a multisig e confere o modelo 2-de-2 com os papéis novos. Só então: CLIENT_A vira REVOGADA (com `revokedAt`), o aparelho antigo é desativado, CLIENT_B entra como ACTIVE, a conta descongela.
9. **Depois** — a sessão do aparelho antigo deixa de valer; o aparelho novo entra assinando um desafio com CLIENT_B. CLIENT_A, se tentar votar, recebe `NotAMember` do programa; se tentar voltar por outra rotação, recebe `REVOKED_KEY_REUSE`.

## Passos (servidor: SERVER_A → SERVER_B)

1. Admin (`POST /v1/admin/accounts/:id/rotations/server`, com `x-admin-token`) pede a rotação com um motivo.
2. O `ServerKeyProvider` gera SERVER_B (em produção, dentro do KMS/HSM); SERVER_B assina a prova de posse; mesmos checks do passo 3 acima.
3. Congela, drena, cria a ConfigTransaction.
4. **O usuário precisa aprovar no app**, que mostra "O serviço está pedindo para trocar a chave de segurança dele" e "Não reconhece este pedido? Rejeite." Sem o app, o prazo vence e a proposta é rejeitada on-chain (teste 9 e "SERVER_A → SERVER_B: o app precisa aprovar").
5. SERVER_A vota, executor executa, verificação on-chain, SERVER_A é aposentada no provedor de chaves.

O token de admin só **pede** a rotação. Não aprova nada e não move nada.

## Testes

| Requisito | Teste |
|---|---|
| Só CLIENT_A aprova → falha; CLIENT_A + SERVER → sucesso; CLIENT_A não vota mais | `onchain.test.ts` Teste 8; `protocol.test.ts` "CLIENT_A → CLIENT_B" |
| Sem o app → falha; CLIENT + SERVER_A → sucesso | `onchain.test.ts` Teste 9; `protocol.test.ts` "SERVER_A → SERVER_B" |
| Trocar a chave nova depois da aprovação → falha | `protocol.test.ts` Teste 10 (três variações) |
| Chave nova sem prova de posse → falha | `protocol.test.ts` Teste 13 (assinatura de outra chave, desafio errado, vencida, operação errada; política recusa rotação sem prova) |
| Chave revogada não volta | `protocol.test.ts` "INVARIANTE 6" e trigger no Postgres |
| Propostas antigas ficam stale; aprovada sobrevive | `onchain.test.ts` "comportamentos do Squads v4" |
