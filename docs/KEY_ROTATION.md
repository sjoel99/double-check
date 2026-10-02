# Troca de chaves

No modelo 2 de 3, qualquer um dos três votantes (Phantom, chave do webapp, serviço) pode ser trocado. Cada troca segue a mesma regra:

1. **Pedido:** uma ConfigTransaction `[AddMember(nova, Vote), RemoveMember(atual)]`, mais `SetRentCollector(nova)` na troca da Phantom. Ela é criada pelo operador e **aprovada por dois votantes** na mesma transação. Um memo assinado pela chave nova prova posse.
2. **Prazo de 72 h** (`DK_SECURITY_DELAY`): o pedido fica aprovado na chain, mas só o operador executa, e ele espera.
3. **"Não fui eu":** quem ainda tem a chave que seria trocada assina o veto. Ele vale na hora.
4. **Execução:** depois do prazo, o operador assina a execução e quem paga assina. O serviço confere o 2 de 3 com a chave nova na chain e atualiza os registros.

## As três trocas

| Troca | Quando | Votam o pedido | Paga | Veta |
|---|---|---|---|---|
| **Trocar a Phantom** | perdeu ou vazou a seed, ou quer outra carteira | chave do webapp + serviço | a Phantom **nova** | a Phantom atual |
| **Recuperar o webapp** | perdeu o aparelho, trocou de celular | Phantom + serviço | a Phantom | a chave atual do webapp |
| **Chave do serviço** | rotação programada ou chave comprometida (admin) | Phantom + serviço | a Phantom | Phantom ou webapp |

**Perdeu a Phantom:** entre com a biometria ("Perdeu a Phantom? Entrar com a biometria"). O aparelho descobre a passkey, pede a cópia cifrada ao serviço, abre a chave do webapp e assina a entrada. Depois peça "Trocar a Phantom".

## Por que uma transação só

Adicionar a chave nova e remover a antiga em transações separadas deixaria quatro votantes com threshold 2 entre os dois passos. A Phantom mais a chave nova, ambas do lado do usuário, moveriam fundos sem o serviço. O teste "PERIGO evitado" reproduz isso no programa real. Na mesma ConfigTransaction, o estado intermediário nunca existe na chain.

## Por que o prazo não está na chain

A Squads v4 tem um time lock só, global, que atrasaria também os envios. O prazo é imposto pelo operador, o único membro com Execute. Se o serviço estiver comprometido, o prazo some, mas o atacante ainda precisa de um segundo voto do usuário.

## Estados

```
PREPARED ──(pedido entra na chain)──► PENDING ──(72 h + execução)──► EXECUTED
   │                                     │
   └─(não assinado a tempo)─► FAILED      └─(Não fui eu)─► VETOED
```

- **PREPARED:** o pedido foi montado e espera as assinaturas (dentro da janela do blockhash).
- **PENDING:** aprovado na chain; começa o prazo.
- **VETOED:** cancelado pela chave que seria trocada; o operador não executa. A proposta fica stale na próxima troca executada.
- **EXECUTED:** a chave nova vale; a antiga fica revogada para sempre.

## Riscos residuais

- **Seed vazada:** o atacante também veta a troca legítima da Phantom, um impasse. Ele não move fundos, porque falta a chave do webapp. O usuário, que tem as duas chaves, pode mover tudo para uma conta nova.
- **Perder a Phantom e todos os aparelhos:** são dois votos do usuário perdidos, e a conta fica bloqueada.
- **Alertas:** o pedido gera e-mail na hora (se o usuário cadastrou um), com a data de execução e o caminho do "Não fui eu". Sem e-mail, só o aviso na tela inicial. O serviço comprometido pode suprimir o e-mail.

## Testes

| Requisito | Teste |
|---|---|
| Uma chave só não troca ninguém | `onchain` Testes 6, 7 |
| Trocar a Phantom: webapp + serviço; só o operador executa | `onchain` Teste 8; `protocol` "trocar a Phantom" |
| Recuperar o webapp: Phantom + serviço | `onchain` Teste 9; `protocol` "recuperar o webapp" |
| Antes de 72 h não executa | `protocol` "trocar a Phantom" (`CHANGE_NOT_DUE`) |
| "Não fui eu": a chave que seria trocada veta; a outra não | `protocol` (duas variações); `onchain` "Não fui eu" |
| Troca aprovada antiga fica stale | `onchain` "troca APROVADA mais antiga" |
| Chave revogada não volta | `protocol` (`KEY_REVOKED`) |
| Pedido não assinado vence | `regressions` A3 |
