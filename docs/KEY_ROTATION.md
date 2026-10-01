# Rotação de chaves

> Modelo atual: o "cliente" é a carteira comum (Phantom, Backpack…). Trocar o cliente = trocar a carteira da conta. A carteira nova prova posse assinando um texto que ela mesma mostra (`signMessage`; pelo celular, um memo). A carteira atual assina e paga **uma transação atômica**: criar a ConfigTransaction, voto do serviço (pré-assinado), voto dela, executar e fechar. Não há congelamento: nada fica pendente na chain.

Duas rotações: a do cliente (trocar de carteira, ou carteira comprometida mas ainda disponível) e a do servidor (rotação programada ou chave do servidor comprometida). As duas exigem **CLIENT atual + SERVER atual** e são uma única ConfigTransaction `[AddMember(nova), RemoveMember(antiga)]`. Na troca da carteira entra também `SetRentCollector(nova)`, para o rent das propostas seguir voltando para a carteira do cliente.

## Regra fundamental

Comprometimento ≠ perda.

- **Chave comprometida, mas ainda disponível**: o atacante tem 1 de 2 votos e não alcança o threshold; o dono legítimo ainda tem a chave e, junto com o outro lado, troca a chave comprometida. Testes 6 e 7 mostram que o atacante sozinho não remove o outro membro; testes 8 e 9 mostram a troca legítima.
- **Chave perdida**: no modo `STRICT_2_OF_2`, perder de vez uma das duas chaves é **bloqueio permanente** — ninguém alcança o threshold para removê-la. Isso é intencional nesta fase; a saída está em RECOVERY.md. Não existe chave mestra, bypass de admin nem threshold 1 temporário.

## Por que uma transação só

O pedido original previa adicionar a nova chave, confirmar, e só depois remover a antiga. Entre um passo e outro a multisig teria 3 votantes com threshold 2 — e CLIENT_A + CLIENT_B, os dois do lado do usuário, moveriam fundos sem o servidor. O teste `PERIGO evitado` reproduz isso no programa real. Com as duas ações na mesma ConfigTransaction, o programa aplica as duas e só depois verifica o invariant: o estado de três votantes nunca existe na chain.

## Máquina de estados

```
REQUESTED ──► NEW_KEY_VERIFIED ──► AWAITING_CLIENT_APPROVAL ──► VERIFIED ──► COMPLETED

saídas: REJECTED · EXPIRED · FAILED · ROLLBACK_REQUIRED
```

| Estado | Significado | Sai para |
|---|---|---|
| REQUESTED | pedido criado; desafio emitido para a chave nova | NEW_KEY_VERIFIED, REJECTED, EXPIRED, FAILED |
| NEW_KEY_VERIFIED | a chave nova assinou o desafio (prova de posse) | AWAITING_CLIENT_APPROVAL, EXPIRED, FAILED |
| AWAITING_CLIENT_APPROVAL | intenção da troca criada (rascunho) e aprovada pela política; esperando a carteira atual assinar a transação atômica | VERIFIED, REJECTED, EXPIRED, FAILED, ROLLBACK_REQUIRED |
| VERIFIED | a transação entrou e `assertStrictTwoOfTwo` passou com os papéis novos, lido da chain | COMPLETED, ROLLBACK_REQUIRED |
| COMPLETED | chave antiga REVOGADA, papéis atualizados | — |
| REJECTED / EXPIRED / FAILED | encerrada aqui; nada a desfazer na chain (a transação só existe se a carteira assinar) | — |
| ROLLBACK_REQUIRED | a chain ficou diferente do esperado depois da troca; exige ação humana | — |

Qualquer transição fora da tabela lança `ROTATION_BAD_TRANSITION` (`ROTATION_TRANSITIONS` em `packages/custody/src/service.ts`).

`OPERATIONS_FROZEN`, `AWAITING_SERVER_APPROVAL` e `EXECUTING` eram do modelo anterior, em que a proposta ficava na chain esperando votos. Continuam no tipo (registros antigos), mas não são mais alcançados.

**A chain manda.** Se a carteira assinou a transação preparada e ela entrou depois de a troca ter sido recusada ou vencida aqui, a conciliação registra a troca como COMPLETED e atualiza membros e papéis (regressão "troca de carteira recusada aqui mas executada na chain").

## Passos (carteira: CARTEIRA_A → CARTEIRA_B)

1. **Pedido** — o app, logado com a carteira atual (A), chama `POST /v1/accounts/:id/rotations/client`. O backend confere a multisig na chain e recusa se já houver troca aberta. Devolve os campos do texto de posse: conta, rede, desafio de 32 bytes e validade. O app guarda o id da troca na sessão: ele só aprova troca pedida por ele.
2. **Carteira nova** — o cliente conecta a carteira B (outra conta da Phantom, ou outra carteira). B assina com `signMessage` o texto:
   ```
   Dupla Chave
   Esta carteira vai substituir a carteira atual da conta.

   Carteira: <B>
   Conta: <multisig>
   Rede: localnet
   Operação: ROTATE_CLIENT_KEY
   Desafio: <hex>
   Válido até: <ISO>
   ```
   Pelo celular, o mesmo texto vai num memo, numa transação paga por B (0,000005 SOL). O backend (com a sessão de A) remonta o texto a partir do que emitiu e confere:
   - operação, conta, rede, desafio e validade;
   - a assinatura é **da própria B**, de uso único;
   - B não é membro, não é chave do serviço e **nunca foi revogada**.
3. **Intenção da troca** — o backend cria a intenção `ROTATE_MEMBER` (rascunho) e roda a política: só a rotação, posse provada, não revogada, máscara do papel. Nada vai para a chain.
4. **Carteira atual assina** — o app pede a transação preparada (`POST /v1/intents/:id/prepare`). O serviço pré-assinou: é o voto dele. O app então:
   - **confere a prova de posse** de B e que a troca foi pedida nesta sessão;
   - remonta a transação a partir da intenção e do estado da chain e compara os bytes;
   - mostra "Trocar a carteira da conta?";
   - pede à **carteira A** que assine e pague.
   B não consegue aprovar a própria entrada: ainda não é membro.
5. **Verificação** — a transação entra (criar, votar, executar e fechar numa só). O backend relê a multisig e confere o 2-de-2 com B (máscara 6, `rent_collector` = B). Só então A vira REVOGADA e B entra como ACTIVE.
6. **Depois** — a sessão de A deixa de valer; B entra assinando o texto de entrada. Se A tentar votar, o programa responde `NotAMember`; se tentar entrar, `KEY_REVOKED`. A partir daqui é B quem paga as taxas.

## Passos (servidor: SERVER_A → SERVER_B)

1. Admin (`POST /v1/admin/accounts/:id/rotations/server`, com `x-admin-token`) pede a rotação com um motivo.
2. O `ServerKeyProvider` gera SERVER_B (em produção, dentro do KMS/HSM), e SERVER_B assina a prova de posse; valem os mesmos checks do passo 2 acima. Antes de assinar, o servidor confere que SERVER_B está no provedor de chaves dele: uma chave do usuário nunca vira "chave do servidor". Uma prova `ROTATE_CLIENT_KEY` é recusada numa rotação de servidor. Se gerar a chave falhar, a rotação vai para `FAILED`.
3. **O cliente precisa assinar com a carteira dele** (e paga a taxa). O app mostra "O serviço está pedindo para trocar a chave de segurança dele" e "Não reconhece este pedido? Recuse." Sem a carteira, o prazo vence e nada muda na chain (teste "SERVER_A → SERVER_B").
4. A transação atômica tem a assinatura de SERVER_A (o voto) e a da carteira. Depois dela, a verificação on-chain, e SERVER_A é aposentada no provedor de chaves.

O token de admin só **pede** a rotação. Não aprova nada e não move nada.

## Testes

| Requisito | Teste |
|---|---|
| Só CLIENT_A aprova → falha; CLIENT_A + SERVER → sucesso; CLIENT_A não vota mais | `onchain.test.ts` Teste 8; `protocol.test.ts` "CARTEIRA_A → CARTEIRA_B" |
| Sem o app → falha; CLIENT + SERVER_A → sucesso | `onchain.test.ts` Teste 9; `protocol.test.ts` "SERVER_A → SERVER_B" |
| Trocar a chave nova depois da aprovação → falha | `protocol.test.ts` Teste 10 (três variações) |
| Chave nova sem prova de posse → falha | `protocol.test.ts` Teste 13 (assinatura de outra chave, desafio errado, vencida, operação errada; política recusa rotação sem prova) |
| Chave revogada não volta | `protocol.test.ts` "INVARIANTE 6" e trigger no Postgres |
| Propostas antigas ficam stale; aprovada sobrevive (motivo do modelo atômico) | `onchain.test.ts` "comportamentos do Squads v4" |
| Troca atômica paga pela carteira; rent_collector passa para a nova | `atomic.test.ts` "troca de carteira atômica"; `protocol.test.ts` "CARTEIRA_A → CARTEIRA_B" |
| Troca recusada aqui mas executada na chain | `regressions.test.ts` A3 |
