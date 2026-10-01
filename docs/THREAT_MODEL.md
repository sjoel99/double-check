# Modelo de ameaças

**Escopo:** a multisig Squads v4 **2 de 3** do Dupla Chave.
- Votam a Phantom, a chave do webapp (cifrada pela biometria do aparelho) e o serviço; só o operador do serviço cria e executa.
- Operações atômicas, pagas pela Phantom.
- Trocas de chave com prazo de 72 h e veto.
- API Fastify sem SOL; webapp no navegador; chaves de serviço de desenvolvimento.

**Premissa central:** o programa da Squads é a fronteira de segurança.
- Mover fundos ou trocar votantes exige **dois votos**.
- Executar exige **o operador**. Nenhum votante executa, o que está provado na chain.
- Backend, banco, política e webapp podem falhar sem que uma chave isolada mova fundos. O que essas camadas protegem é a qualidade das decisões.

**Escala de impacto:**
- **crítico:** perda de fundos;
- **alto:** aprovar algo indesejado com ajuda de outra falha, ou bloqueio da conta;
- **médio:** negação de serviço, vazamento de metadados;
- **baixo.**

| # | Ameaça | Impacto | Mitigação | Risco residual |
|---|---|---|---|---|
| 1 | **Aparelho roubado** | Alto se desbloqueado | A chave do webapp só abre com a biometria do aparelho; a Phantom tem a senha/biometria dela; o serviço aplica a política | Quem desbloquear Phantom **e** biometria assina dentro da política. Perder o aparelho: "Recuperar o webapp" com a Phantom + 72 h |
| 2 | **Malware no aparelho** | Alto | Biometria a cada assinatura; o webapp confere os bytes; política no serviço | Malware que controla Phantom e biometria assina dentro da política |
| 3 | **Seed da Phantom vazada** | Alto | 1 de 3 votos, sem executar. Para mover fundos falta a chave do webapp (biometria). O único caminho é pedir "recuperar o webapp", que leva 72 h, gera alerta e é vetado pela chave atual do webapp (D17) | O atacante entra na conta e vê saldo e histórico. Ele também veta uma troca legítima da Phantom (impasse; o usuário move tudo para uma conta nova) |
| 4 | **Chave do webapp vazada** (capturada por malware ou webapp adulterado) | Alto | 1 voto. Falta a Phantom. O caminho é pedir "trocar a Phantom": 72 h, alerta, veto pela Phantom atual | Com a Phantom também: ver #1 |
| 5 | **Chave do serviço vazada** | Médio | 1 voto, e o serviço nunca vota em envios. Sem operador, nada executa | O atacante precisa de um segundo voto do usuário (#3/#4) |
| 6 | **Serviço inteiro comprometido** (voto + operador + cópias cifradas) | Alto | Ainda é 1 voto. As cópias cifradas não abrem sem a biometria. Envios precisam de Phantom + webapp (teste "INVARIANTE 3") | Ver #31: servir um webapp adulterado que capture a chave do webapp no momento da biometria. Com ela, mais o voto do serviço, são 2 votos |
| 7 | **Banco comprometido** | Médio | O banco não decide: papéis e índices vêm da chain; o operador só assina mensagens preparadas, com a assinatura do webapp; auditoria encadeada só de inserção | Apagar uma troca pendente do banco não executa nada; apagar um veto e executar exige o operador (#6) |
| 8 | **RPC malicioso** | Alto | RPC do webapp fixada no build (quórum opcional com duas RPCs); a API não indica RPC | Controlar a(s) RPC(s) do build engana a conferência |
| 9 | **MITM** | Médio | TLS; nada do que trafega autoriza sozinho: o operador exige a assinatura do webapp sobre bytes que ele preparou | DoS |
| 10 | **Replay** | Médio | A transação atômica cria a conta no índice dela (não entra duas vezes) e o blockhash expira; o operador só assina mensagens preparadas, dentro da janela; desafios de uso único | — |
| 11 | **Phishing** (site falso) | Alto | A passkey é presa ao domínio: num site falso a biometria não abre a chave do webapp. Sem ela, a Phantom sozinha não move nada | Usuário levado a criar conta num site falso e depositar lá |
| 12 | **Substituição da transação** | Alto | O webapp remonta e compara os bytes; o operador só assina o que preparou; a chave do webapp assina os bytes exatos | — |
| 13 | **Supply chain** (npm, extensões) | Crítico | Poucas dependências, versões travadas, ELF da Squads conferido por sha256 | Um pacote comprometido no webapp vê a chave do webapp aberta (#31) |
| 14 | **Insider** | Alto | Igual a #6. Token de admin só pede a troca da chave do serviço, que exige a Phantom e as 72 h | — |
| 15 | **Notificação falsa** | Médio | Notificação só avisa; o webapp busca e confere | Engenharia social |
| 16 | **Spending limit / config authority** | Crítico | Multisig autônoma, conferida na chain e na criação; a política recusa qualquer ConfigTransaction que não seja a troca de um votante | — |
| 17 | **Troca de chave indevida** | Alto | Dois votos + memo da chave nova + 72 h + veto pela chave que seria trocada; uma troca por vez | Sem alerta real, o usuário pode não ver o pedido a tempo (alertas reais pendentes) |
| 18 | **Aprovação antiga** (troca aprovada e vetada) | Médio | Só o operador executa e ele recusa as vetadas; a próxima troca executada a deixa stale (provado na chain) | Serviço comprometido (#6) poderia executar uma vetada antes de ela ficar stale, mas ainda é 1 voto do lado dele + o do pedido |
| 19 | **Webapp + serviço aprovando sem a Phantom** | Alto | O programa aceita (2 de 3, provado), por isso o serviço **nunca vota em envios** e só vota trocas, com prazo | Serviço comprometido com a chave do webapp capturada (#31) |
| 20 | **Assinatura cega na Phantom** | Médio | A Phantom mostra instruções da Squads; o webapp confere os bytes; a biometria confirma | Webapp adulterado mostra uma coisa e assina outra (#31) |
| 21 | **QR de entrada roubado** | Médio | A sessão só identifica; assinar exige Phantom + biometria | O atacante vê saldo e histórico |
| 22 | **Token do QR de assinatura vazado** | Baixo | O token só abre aquela intenção e a cópia **cifrada** da chave; assinar exige biometria + Phantom; uso único | Ver o valor e o destino daquela intenção |
| 23 | **Esgotar o pagador** | — | Não há pagador: o serviço não tem SOL | — |
| 24 | **Gerar chaves do serviço em massa** | Médio | Cadastro limitado por IP; cadastros não assinados são descartados | Abuso lento por muitos IPs |
| 25 | **Aparelho sem PRF** | Médio | `/#/prf` testa; o cadastro recusa aparelho sem PRF | Usuário sem aparelho compatível não usa |
| 26 | **Perder todos os aparelhos e a Phantom** | Alto | — | **Bloqueio**: dois votos do usuário perdidos. Recuperação além disso exigiria uma terceira chave do usuário |
| 31 | **Webapp adulterado servido pelo serviço comprometido** | Alto | A chave do webapp só fica aberta durante a assinatura; CSP estrita; o webapp é estático | Quem controla o código que o navegador roda vê a chave aberta. Endurecimento: hospedar o webapp separado do serviço, build reproduzível |

## Revisão de 2026-10-01

A revisão adversarial do modelo 2 de 2 achou 5 bugs confirmados com teste (A1–A5) e 3 por leitura (B1–B3), todos corrigidos. No modelo 2 de 3, as regressões em `tests/regressions.test.ts` cobrem:
- duas transações preparadas no mesmo índice;
- transação preparada que entra depois de recusada;
- o operador não assina mensagem alterada nem vencida;
- cópia extra da chave do webapp só com a assinatura dela;
- expiração concorrendo com o envio.

## Invariantes e onde estão provadas

Ver `docs/SECURITY_INVARIANTS.md`.
