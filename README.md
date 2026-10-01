# Dupla Chave

Custódia na Solana em que **nenhuma chave sozinha move fundos**. Os ativos ficam no Vault de uma multisig [Squads v4](https://github.com/Squads-Protocol/v4) 2-de-2 com dois votantes:

- **a carteira comum do cliente** (Phantom, Backpack, Solflare… qualquer carteira do Wallet Standard);
- **a chave do serviço**, que só aprova o que passa pela política (limites, destinos, programas, simulação).

Executor e proponente do serviço não votam. Trocar a carteira ou a chave do serviço também exige as duas.

**O serviço não paga nada.** Taxas e rent saem da carteira do cliente. Cada operação é uma transação atômica: o serviço assina antes, a carteira assina por último e paga, e criar, aprovar, executar e fechar acontecem juntos.

| | Custo para a carteira |
|---|---|
| Criar a conta (uma vez) | ~0,003 SOL |
| Cada envio ou troca de chave | 0,000015 SOL. Na hora, a carteira precisa *ter* ~0,0065 SOL: o depósito das contas da Squads volta na mesma transação |
| Depósito no Vault | 0,000005 SOL |
| Entrar pelo celular / prova da carteira nova pelo celular | 0,000005 SOL (o Solana Pay não tem assinatura de mensagem) |
| Entrar pela extensão | grátis (assinatura de texto) |

Quem garante isso é o programa da Squads. Backend, banco e app podem falhar sem que uma chave isolada mova fundos. Os testes atacam o programa direto para provar.

## Os dois fluxos

**Cadastro**
1. O cliente conecta a carteira que já usa.
2. O serviço prepara a criação da conta 2-de-2 (carteira do cliente + chave nova do serviço), com um memo de vínculo. O app confere a transação: só a criação, com os membros certos, sem nada escondido.
3. A carteira assina e paga (~0,003 SOL). A conta existe na Solana.

**Transação**
1. O cliente pede o envio no app. O serviço confere a política e simula; nada vai para a chain.
2. O serviço prepara a transação atômica (ainda sem assinar).
3. O app remonta a transação sozinho, a partir do que mostra na tela, e compara byte a byte.
4. **Biometria:** o app pede a digital ou o rosto do aparelho (passkey) sobre esses bytes exatos. Só então o serviço assina a parte dele.
5. O cliente assina **uma vez** na carteira, que paga a taxa. Se algo falhar, nada acontece na Solana.

A biometria é ativada uma vez por aparelho: a carteira assina um texto vinculando a passkey à conta. Uma biometria nova precisa da aprovação de uma já ativa; sem isso, espera 48 h antes de valer.

## Pelo celular (QR)

O QR do computador abre **o nosso app** no navegador do celular. Ali o app confere a transação, pede a biometria do celular e só então chama a Phantom, pelo Mobile Wallet Adapter (Android). A Phantom assina e o computador segue sozinho. Entrar e provar a carteira nova são assinaturas de texto, sem custo.

### Testar com o seu celular (devnet)

```bash
pnpm dev:devnet
```

O script:
- sobe um túnel HTTPS (cloudflared) para o app, porque o celular e a biometria exigem HTTPS;
- sobe um Postgres em Docker e chaves persistentes;
- aponta tudo para a devnet.

Quem paga é a sua Phantom: ela precisa de SOL de devnet (https://faucet.solana.com; 0,05 SOL dá para muitos testes).

Na Phantom do celular, ative o modo devnet: Configurações → Configurações de desenvolvedor → Modo testnet → Solana Devnet. No computador, abra o endereço do túnel que o script imprime (ou http://localhost:5173). O 127.0.0.1 não serve para biometria.

A biometria fica presa ao domínio. O túnel muda a cada `pnpm dev:devnet`, então cada reinício pede uma biometria nova, que vale 5 minutos depois (`DK_PASSKEY_RESET_DELAY`).

Em localnet (`pnpm dev`), há a **biometria de teste** e o botão **Abrir no celular de teste**, que abre o link do QR em outra aba. Assim dá para testar o caminho do QR sem aparelho.

## Testar agora

```bash
cd ~/Desenvolvimento/Pessoal/duplachave
pnpm install
pnpm test     # 84 testes, ~4 s, sem rede: o Squads v4 da mainnet rodando no LiteSVM
pnpm dev      # surfpool offline (Squads v4 das fixtures) + API :8787 + app :5173
```

Abra **http://127.0.0.1:5173**.

### Roteiro (5 minutos)

1. **Escolha a carteira.** Em localnet há duas **Carteiras de teste** (A e B) que imitam a janela da Phantom: dá para testar sem extensão e sem SOL de verdade. O app pede SOL de teste para ela, prepara a criação da conta e a carteira assina (pagando ~0,003 SOL). Em seguida, **ative a biometria de teste**: confirme a janela da biometria e a carteira assina o vínculo.
2. **Depositar:** toque em **Depositar** e informe o valor. A carteira assina e paga a transferência para o Vault, e o app envia. Também dá para usar "10 SOL no Vault" direto.
3. **Enviar:** cole um endereço de carteira e o valor, depois toque em **Revisar**. A tela mostra "Conferido: a transação faz exatamente isto…". **Confirmar e assinar** pede a biometria, o serviço assina, a carteira abre uma vez e a transação executa; a carteira paga 0,000015 SOL. Em "Ou continuar no celular (QR)" → **Abrir no celular de teste**, a outra aba faz o mesmo papel do celular.
4. **Servidor malicioso:** marque a opção nas ferramentas de teste e faça outro envio. O servidor mostra 1/10 do valor; o app remonta a transação, vê que não bate, mostra **Transação bloqueada** com o valor real e não pede assinatura.
5. **Trocar de carteira:** Segurança → Trocar a carteira → Começar → escolha a **Carteira de teste B** e assine o texto. Depois toque em **Revisar e assinar a troca**: a carteira **atual** (A) assina e paga. Por fim, entre com a B (ela precisa de SOL para os próximos envios: "5 SOL na carteira").
6. **Troca da chave do serviço:** use "Simular pedido de troca da chave do serviço" e assine (ou recuse: nada muda).

### Com a Phantom de verdade

A Phantom aparece na lista sozinha, pelo Wallet Standard. Em localnet, assinar mensagens e transações funciona. Mas a Phantom simula a transação na rede dela (mainnet/devnet), onde esta conta não existe, então ela pode mostrar um aviso de que não conseguiu simular. Para testar sem esse aviso, rode em devnet: `SOLANA_RPC_URL=https://api.devnet.solana.com SOLANA_CLUSTER=devnet pnpm dev`, com SOL de devnet na Phantom e ela em devnet (ou use `pnpm dev:devnet`).

A Phantom precisa de SOL na rede em que está: em localnet o app pede SOL de teste para ela no cadastro.

Na troca de carteira com a mesma Phantom, troque de conta dentro dela entre os passos: a conta nova assina o texto e a atual assina a troca. O app avisa qual conta tem que estar ativa.

### Ambiente

O surfpool roda **offline**, com o ELF do Squads v4 carregado das fixtures. No modo fork (`SURFPOOL_FORK=1 pnpm dev`), cada conta nova vira uma consulta ao RPC público da mainnet, que limita por IP e fazia as aprovações falharem com "Internal error". Tudo fica em memória (API e surfpool): reiniciar `pnpm dev` zera as contas.

## O que está provado

`pnpm test` roda contra o ELF do Squads v4 baixado da mainnet (sha256 em `fixtures/ORIGEM.md`):

```
carteira sozinha = impossível                (Teste 1)
serviço sozinho = impossível                 (Teste 2)
carteira + serviço = possível                (Teste 3)
trocar a carteira exige carteira + serviço   (Testes 6, 8)
trocar a chave do serviço exige os dois      (Testes 7, 9)
criar + aprovar + executar é atômico         (falha não deixa nada na chain)
o serviço não gasta SOL                      (a carteira paga taxa e rent; o rent volta)
```

Também estão cobertos:
- executor e proponente não votam;
- a carteira não cria transações no Vault;
- replay;
- expiração;
- prova de posse da carteira nova;
- trocar a chave nova depois da aprovação;
- backend inteiro comprometido;
- app mostrando A enquanto a chain tem B;
- auditoria adulterada.

O mapa completo está em [docs/SECURITY_INVARIANTS.md](docs/SECURITY_INVARIANTS.md).

## Documentos

- [docs/RESEARCH.md](docs/RESEARCH.md): versões, APIs usadas e o comportamento do programa.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): fluxo, membros e decisões de segurança.
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md): ameaças com impacto, mitigação e risco residual.
- [docs/KEY_ROTATION.md](docs/KEY_ROTATION.md): troca da carteira e da chave do serviço, e a máquina de estados.
- [docs/RECOVERY.md](docs/RECOVERY.md): por que não há recuperação no v4 puro e os caminhos possíveis.
- [docs/SECURITY_INVARIANTS.md](docs/SECURITY_INVARIANTS.md): invariantes ↔ testes.

## Estrutura

```
apps/api               Fastify: cadastro/login por assinatura, intenções, transação da carteira, troca de carteira
apps/approval-web      app (React; Wallet Standard; carteiras de teste em localnet)
packages/shared        intenção canônica (hash), schemas, erros
packages/crypto        Signer/ServerSigner, textos que a carteira assina (vínculo, login)
packages/solana        Chain (RPC | LiteSVM), leitor de instruções
packages/squads        estado on-chain, construtores, invariantes, derivação da intenção
packages/policy-engine política padrão
packages/custody       orquestração (servidor) e revisão + montagem da transação (app)
packages/database      Postgres (PgStore) + migração
tests/                 on-chain, protocolo, regressões, banco
fixtures/              ELF do Squads v4 e ProgramConfig da mainnet
```

## Outros comandos

```bash
pnpm typecheck                     # pacotes, API e app
pnpm smoke                         # fluxo completo via RPC (surfpool ou devnet) sem o app
pnpm fixtures                      # baixa de novo o ELF da Squads da mainnet
docker run -d --rm --name dk-pg -e POSTGRES_PASSWORD=dk -e POSTGRES_DB=dk -p 55432:5432 postgres:17-alpine
pnpm test:pg                       # protocolo inteiro num Postgres real
DATABASE_URL=postgres://... pnpm dev   # API persistindo em Postgres
```

## Limites desta versão

- **Assinatura de uma vez só.** A carteira mostra uma transação técnica (instruções da Squads), não "enviar 2,5 SOL para X". O que o cliente vê é a tela do app, que remonta a transação e compara os bytes. Se o app (frontend) for adulterado, o cliente pode assinar algo que não pediu. Nesse caso, a política do serviço (limites, lista de endereços) é o que segura. Endurecimento possível: a carteira assinar também um texto com o resumo (duas janelas). Ver THREAT_MODEL #24.
- **Mainnet bloqueada.** As chaves do serviço são de desenvolvimento; é preciso KMS/HSM antes.
- **Modo estrito.** Perder a carteira (seed phrase) sem trocar antes **bloqueia a conta**. Recuperação ainda é pesquisa (RECOVERY.md), não código.
- **Só transferência de SOL.** Swap fica para depois.
- **Notificações simuladas.** São um mock que só registra no log.
- **A carteira precisa de SOL.** Sem ~0,0065 SOL na hora, o app avisa e não prepara a transação. Cadastros preparados e não assinados ficam em memória na API (~3 min).
