# Dupla Chave

Custódia na Solana em que **nenhuma chave sozinha move fundos**. Os ativos ficam no Vault de uma multisig [Squads v4](https://github.com/Squads-Protocol/v4) 2-de-2 com dois votantes:

- **a carteira comum do cliente** (Phantom, Backpack, Solflare… qualquer carteira do Wallet Standard);
- **a chave do serviço**, que só aprova o que passa pela política (limites, destinos, programas, simulação).

Executor e proponente do serviço não votam. Trocar a carteira ou a chave do serviço também exige as duas.

Quem garante isso é o programa da Squads. Backend, banco e app podem falhar sem que uma chave isolada mova fundos. Os testes atacam o programa direto para provar.

## Os dois fluxos

**Cadastro**
1. O cliente conecta a carteira que já usa.
2. A carteira assina um texto de vínculo, que ela mesma mostra na janela dela.
3. A conta 2-de-2 é criada na Solana: carteira do cliente + chave do serviço.

**Transação**
1. O cliente pede o envio no app.
2. O serviço monta a transação, confere a política, simula e aprova.
3. O cliente assina **uma vez** na carteira. Essa transação aprova e executa junto; se a execução falhar, nada fica aprovado.

## Testar agora

```bash
cd ~/Desenvolvimento/Pessoal/duplachave
pnpm install
pnpm test     # 69 testes, ~4 s, sem rede: o Squads v4 da mainnet rodando no LiteSVM
pnpm dev      # surfpool offline (Squads v4 das fixtures) + API :8787 + app :5173
```

Abra **http://127.0.0.1:5173**.

### Roteiro (5 minutos)

1. **Escolha a carteira.** Em localnet há duas **Carteiras de teste** (A e B) que imitam a janela da Phantom: dá para testar sem extensão e sem SOL de verdade. Assine o texto de vínculo e a conta é criada.
2. **Depositar:** use "5 SOL na carteira" (ferramentas de teste) e depois **Depositar**. A carteira assina a transferência para o Vault e o serviço paga a taxa. Também dá para usar "10 SOL no Vault" direto.
3. **Enviar:** cole um endereço de carteira e o valor, depois toque em **Revisar**. A tela mostra "Conferido na Solana… O serviço já conferiu a política e aprovou". **Assinar** abre a carteira uma vez e a transação executa.
4. **Servidor malicioso:** marque a opção nas ferramentas de teste e faça outro envio. O servidor mostra 1/10 do valor; o app compara com a chain, mostra **Transação bloqueada** e não pede assinatura.
5. **Trocar de carteira:** Segurança → Trocar a carteira → Começar → escolha a **Carteira de teste B** e assine o texto. Depois toque em **Revisar e assinar a troca**: a carteira **atual** (A) assina. Por fim, entre com a B.
6. **Troca da chave do serviço:** use "Simular pedido de troca da chave do serviço" e assine (ou recuse: nada muda).

### Com a Phantom de verdade

A Phantom aparece na lista sozinha, pelo Wallet Standard. Em localnet, assinar mensagens e transações funciona. Mas a Phantom simula a transação na rede dela (mainnet/devnet), onde esta conta não existe, então ela pode mostrar um aviso de que não conseguiu simular. Para testar sem esse aviso, rode em devnet: `SOLANA_RPC_URL=https://api.devnet.solana.com SOLANA_CLUSTER=devnet pnpm dev`, com SOL de devnet no pagador e a Phantom em devnet.

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
aprovar + executar numa transação é atômico  (falha na execução não deixa voto)
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

- **Assinatura de uma vez só.** A carteira mostra uma transação técnica (aprovar + executar na Squads), não "enviar 2,5 SOL para X". O que o cliente vê é a tela do app, que confere a chain. Se o app (frontend) for adulterado, o cliente pode assinar algo que não pediu. Nesse caso, a política do serviço (limites, lista de endereços) é o que segura. Endurecimento possível: a carteira assinar também um texto com o resumo (duas janelas). Ver THREAT_MODEL #24.
- **Mainnet bloqueada.** As chaves do serviço são de desenvolvimento; é preciso KMS/HSM antes.
- **Modo estrito.** Perder a carteira (seed phrase) sem trocar antes **bloqueia a conta**. Recuperação ainda é pesquisa (RECOVERY.md), não código.
- **Só transferência de SOL.** Swap fica para depois.
- **Notificações simuladas.** São um mock que só registra no log.
