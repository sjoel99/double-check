# Arquitetura

Custódia na Solana sobre uma multisig Squads v4 **2 de 3**. Votam:
- a **Phantom** do usuário;
- a **chave do webapp**, uma chave guardada cifrada e destravada pela biometria do aparelho;
- a chave do **serviço** (backend).

Só o **operador** do serviço cria e executa propostas. Votar e executar são permissões separadas na Squads; como o único executor é o operador, nada aprovado roda sem o serviço conferir a política. E os votos que ele tem não bastam sozinhos.

Termos: **webapp** é o que roda no Chrome (computador ou celular); **Phantom** é a carteira externa (app ou extensão); **serviço** é o backend.

> Histórico, todo em 2026-10-01:
> 1. A primeira versão usava uma chave própria no app.
> 2. Virou 2 de 2: carteira comum + serviço.
> 3. Ficou atômica e paga pela carteira.
> 4. A biometria virou uma regra do serviço.
> 5. Por fim, a pedido do produto ("não estou confortável"), a biometria virou **voto de verdade**: modelo 2 de 3 com operador único executor, prazo de 72 h nas trocas e chave do webapp cifrada guardada no serviço. As decisões estão em D15–D18.

## Membros

| Papel | Permissão | Onde mora | O que consegue sozinho |
|---|---|---|---|
| Phantom | Vote | Phantom do usuário | nada: 1 voto; não executa |
| Chave do webapp | Vote | cifrada (AES-GCM) com a PRF da passkey; o serviço guarda só o texto cifrado | nada: 1 voto; não executa |
| Chave do serviço | Vote | KMS/HSM (dev: arquivo cifrado) | nada: 1 voto. Só vota em **trocas de chave**, nunca em envios |
| Operador do serviço | Initiate + Execute | servidor | cria e executa o que **já** tem 2 votos; não vota |

Configuração fixa, conferida na chain por `assertAccountModel` antes de cada decisão e depois de cada troca:
- threshold 2;
- exatamente esses 3 votantes, cada um só com Vote;
- o operador como único membro com Execute;
- `config_authority = default`;
- `time_lock = 0` (o prazo é imposto pelo operador; ver D16);
- `rent_collector` = Phantom.

## Chave do webapp (D15)

- **Criação, no aparelho:** uma chave Ed25519 nova. O webapp cria uma passkey com a extensão **PRF** do WebAuthn; a PRF devolve um segredo de 32 bytes, que só sai do autenticador com a biometria. HKDF desse segredo dá uma chave AES-256-GCM, que cifra a semente da chave do webapp. O dado extra autenticado da cifra é a chave pública.
- **No serviço:** o texto cifrado (`webapp_keys`). Sem a biometria do aparelho, ele não abre.
- **Uso:** biometria → PRF → abre a semente por um instante → assina → apaga da memória.
- **Sal da PRF fixo:** assim a passkey pode ser descoberta sem saber antes qual é. Isso serve a quem perdeu a Phantom (D18) e a aparelhos com a passkey sincronizada pelo gerenciador de senhas.
- **Localnet** (127.0.0.1, sem WebAuthn): a "biometria de teste" é uma PRF em software (HMAC com chave não exportável no IndexedDB), com janela de confirmação.
- **Extra:** `POST /v1/accounts/:id/webapp-keys` guarda mais uma cópia cifrada (para outra passkey), mas só com a assinatura da própria chave do webapp.

## A operação atômica

```
[ vault_transaction_create(creator = operador, rent_payer = Phantom, memo = dk1:<hash da intenção>)
  proposal_create(creator = operador, rent_payer = Phantom)
  proposal_approve(Phantom)
  proposal_approve(chave do webapp)
  vault_transaction_execute(member = operador)
  vault_transaction_accounts_close(rent_collector = Phantom) ]
pagador: Phantom · assinaturas: Phantom, chave do webapp, operador
```

1. **Rascunho** (`POST /v1/accounts/:id/intents`): política, destino, simulação. Nada vai para a chain.
2. **Preparar** (`POST /v1/intents/:id/prepare`): índice atual, política e simulação de novo, simulação da transação inteira. Sai sem assinatura nenhuma.
3. **Conferir** (`reviewPrepared`): o webapp lê a multisig pela RPC fixada no build. Tira da chain o serviço (o votante que sobra) e o operador. Remonta a transação a partir da intenção exibida e compara byte a byte.
4. **Biometria:** abre a chave do webapp, que assina **esses bytes**.
5. **Operador** (`POST /v1/intents/:id/authorize {message, webappSignature}`): o serviço só assina mensagens que ele preparou, dentro da janela, e só com a assinatura válida da chave do webapp da conta.
6. **Conferir as assinaturas** (`verifyAuthorized`): mesmos bytes, operador e webapp válidos.
7. **Phantom:** assina por último e paga.
8. **Enviar** (`POST /v1/intents/:id/submit`): o serviço confere que é uma mensagem preparada e envia.

Tudo ou nada: se a execução falha, nem a proposta fica na chain.

**Custos:**
- 3 assinaturas: 0,000015 SOL por envio;
- o rent das contas da proposta é cobrado e devolvido na mesma transação: a Phantom precisa *ter* ~0,0065 SOL, mas não gasta;
- cadastro: ~0,003 SOL.

## Cadastro

1. O webapp gera a chave do webapp (biometria) e conecta a Phantom.
2. `POST /v1/enrollment/prepare {publicKey, webappPublicKey}`: memo assinado pela Phantom **e** pela chave do webapp (prova de posse das duas na própria transação) + `multisig_create_v2` (criador e pagador: a Phantom). Chave nova do serviço, operador do serviço.
3. O webapp confere a transação (`verifyEnrollmentTransaction`): só o memo e a criação 2 de 3 com esta Phantom e esta chave votando, um terceiro votante, o operador como único executor, sem config authority nem time lock, e o rent de volta para a Phantom. Nada escondido.
4. A chave do webapp assina, a Phantom assina e paga, e `POST /v1/enrollment/submit` leva junto a cópia cifrada da chave do webapp.

## Trocas de chave com prazo (D16, D17)

Dois passos:

1. **Pedido** (`POST /v1/accounts/:id/security-changes`, depois `/authorize` e `/submit`): uma ConfigTransaction `[AddMember(nova, Vote), RemoveMember(atual)]` (mais `SetRentCollector(nova)` na troca da Phantom), criada e **aprovada por dois votantes na mesma transação**. Um memo assinado pela chave nova prova posse.
2. **Execução** (`/execute-prepare`, `/execute`): só o operador executa, e **só depois de 72 h** (`DK_SECURITY_DELAY`). Quem paga assina a execução.

| Troca | Votam o pedido | Quem paga | Quem veta ("Não fui eu") |
|---|---|---|---|
| Trocar a Phantom | webapp + serviço | a Phantom **nova** | a Phantom atual |
| Recuperar o webapp | Phantom + serviço | a Phantom | a chave atual do webapp |
| Chave do serviço | Phantom + serviço | a Phantom | Phantom ou webapp |

- **Veto:** é uma assinatura de texto (`vetoMessage`) pela chave que seria trocada. Quem ainda tem essa chave prova que ela não está perdida. Como só o operador executa, o veto vale na hora. A proposta aprovada fica stale na próxima troca executada, o que está provado na chain.
- **Uma troca aberta por vez.** Operações normais continuam durante o prazo.
- **Alertas:** e-mail pela Resend no pedido (com o prazo e o caminho do "Não fui eu"), no veto e na execução. Ver D19.

### D19. E-mail de alerta

- **Problema:** o prazo de 72 h só protege se o usuário souber do pedido a tempo.
- **Decisão:** alertas por e-mail pela API HTTP da Resend (sem SDK): pedido, veto e execução de troca, envio executado, modelo diferente do esperado e troca de e-mail.
- **Cadastro do e-mail:** `POST /v1/accounts/:id/email/start {email, signature}`, depois `/confirm {challengeId, code}`.
  - A `signature` é da **chave do webapp** sobre `emailBindingMessage(multisig, email)`. Quem só tem a seed da Phantom tem sessão, mas não desvia os alertas.
  - O código tem 6 dígitos, vale 10 min e aceita uma tentativa; o serviço guarda só o hash.
  - A troca avisa o endereço antigo e o novo.
- **O que o e-mail não tem:** link que autorize algo ou dado secreto. Ele só aponta para `/#/security`, onde tudo é conferido.
- **Falha de envio:** não derruba a operação; fica no log.
- **Risco residual:** o serviço comprometido (#6) pode deixar de mandar alertas. O webapp continua mostrando a troca pendente na tela inicial.

## Celular

O QR do computador abre **o nosso webapp** no celular (`<URL>/#/m/<token>`).
- **Assinar:** o celular não precisa entrar na conta. O token dá acesso àquela intenção e à cópia cifrada da chave (`/v1/handoff/:token/{intent,key,prepare,authorize,submit,reject}`). Conferência, biometria do celular, operador, e a Phantom pelo **Mobile Wallet Adapter**, que no Android conecta e assina na mesma abertura.
- **Entrar:** o celular entra com a Phantom e entrega uma sessão ao computador.

## Decisões de segurança

As decisões D1–D14 do modelo 2 de 2 estão no histórico do git (commit `b210c7a`). As que continuam valendo:
- **D1:** rotação numa ConfigTransaction só.
- **D4:** spending limit e config authority proibidos.
- **D5:** bytes idênticos.
- **D6:** RPC fixada no build.
- **D9:** sessão não autoriza.
- **D10:** o banco é índice.
- **D11:** auditoria encadeada.
- **D13:** quem paga é o usuário; o serviço não tem SOL.

### D15. Chave do webapp como voto (PRF)

- **Problema:** a biometria era uma regra do serviço. Com a seed da Phantom vazada, alguém vinculava uma biometria nova pelo próprio serviço.
- **Alternativas:**
  - (a) 2 de 2 endurecido;
  - (b) 3 de 3;
  - (c) 2 de 3 com operador único executor;
  - (d) trocar a Phantom pela chave do webapp;
  - (e) outro programa (Smart Account, Swig).
- **Decisão (do produto):** (c), com a chave do webapp cifrada pela PRF e guardada no serviço.
- **Trade-offs:**
  - depende da PRF no aparelho: Chrome no Android com o gerenciador de senhas do Google suporta; a página `/#/prf` testa;
  - a chave aparece aberta no navegador por um instante, então um webapp adulterado servido pelo serviço comprometido pode capturá-la (ver THREAT_MODEL #31);
  - perder todos os aparelhos com a passkey exige a recuperação com prazo (D17).

### D16. Prazo imposto pelo operador

- **Problema:** a Squads v4 tem um time lock só, global, que atrasaria também os envios.
- **Decisão:** sem time lock na chain. O operador (único executor) só executa trocas depois de 72 h. Se o serviço estiver comprometido, o prazo some, mas o atacante ainda precisa de um segundo voto.

### D17. Quem veta

- **Decisão:** veta quem ainda tem a chave que seria trocada.
  - Seed vazada pedindo a recuperação do webapp: a chave do webapp veta.
  - Chave do webapp vazada pedindo a troca da Phantom: a Phantom veta.
- **Risco residual:** com a seed vazada, o atacante também veta a troca legítima da Phantom, um impasse. Ele não move fundos (falta a chave do webapp), e o usuário, que tem as duas chaves, pode mover tudo para uma conta nova.

### D18. Entrar sem a Phantom

Quem perdeu a Phantom entra com a chave do webapp (`POST /v1/auth/webapp`, assinatura do texto de entrada). O aparelho descobre a passkey e pede a cópia cifrada ao serviço (`/v1/webapp-keys/lookup`, que entrega só texto cifrado). Depois pede "Trocar a Phantom".

## Ambientes

| Variável | Uso |
|---|---|
| `SOLANA_RPC_URL`, `SOLANA_CLUSTER` | RPC e cluster do backend (mainnet recusada nesta versão) |
| `VITE_RPC_URL`, `VITE_RPC_URL_2`, `VITE_CLUSTER` | RPC(s) e cluster do webapp, fixados no build |
| `DATABASE_URL` | Postgres; sem ela, memória |
| `DK_SESSION_SECRET`, `DK_ADMIN_TOKEN` | sessão e admin |
| `DK_KEY_ENCRYPTION_KEY`, `DK_KEYS_DIR` | "KMS" de desenvolvimento (chaves do serviço e do operador) |
| `DK_PUBLIC_URL` | URL HTTPS do webapp (QR "continuar no celular") |
| `RESEND_API_KEY`, `DK_EMAIL_FROM` | alertas por e-mail (remetente num domínio verificado na Resend); sem eles, só log |
| `DK_SECURITY_DELAY` | prazo das trocas em segundos (padrão 259200 = 72 h; `pnpm dev` usa 120) |

## Fora desta entrega

- vincular um aparelho novo à mesma chave do webapp sem sincronizar a passkey (hoje: sincronização do gerenciador de senhas ou recuperação com prazo);
- Mobile Wallet Adapter no iPhone (deeplink da Phantom);
- swap e tokens SPL;
- KMS/HSM e mainnet;
- migração das contas do modelo 2 de 2.
