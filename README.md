# Dupla Chave

Custódia na Solana em que **nenhuma chave sozinha move fundos**. Os ativos ficam no Vault de uma multisig [Squads v4](https://github.com/Squads-Protocol/v4) 2-de-2: uma chave no aparelho do usuário (CLIENT), outra no serviço (SERVER), que só assina o que passa pela política. Executor e wallet operacional não votam. Trocar qualquer uma das duas chaves também exige as duas.

O programa da Squads é quem impõe isso. Backend, banco e app podem falhar sem que uma chave isolada mova fundos — os testes atacam o programa direto para provar.

## Testar agora

```bash
cd ~/Desenvolvimento/Pessoal/duplachave
pnpm install
pnpm test     # 46 testes, ~3 s, sem rede: o Squads v4 da mainnet rodando no LiteSVM
pnpm dev      # surfpool (fork local da mainnet) + API :8787 + Approval App :5173
```

Abra **http://127.0.0.1:5173** (Chrome 137+, Firefox 129+ ou Safari 17+: precisa de Ed25519 no WebCrypto).

Roteiro no app (5 minutos):

1. **Criar minha chave** → PIN de 6 dígitos. A chave nasce no navegador, não exportável; a multisig 2-de-2 é criada na chain local.
2. **Depositar 10 SOL de teste** (ferramentas de teste, no fim da tela inicial).
3. **Enviar SOL** → cole um endereço de carteira (gere um com `solana-keygen` ou use qualquer carteira sua; **não** use endereço de programa — é recusado) → valor → Continuar. A tela diz "Conferido na Solana: idêntico ao que você vê". **Aprovar** → PIN → as quatro etapas aparecem com as assinaturas.
4. **Servidor malicioso**: marque "Simular servidor malicioso" e faça outro envio. O servidor passa a mostrar 1/10 do valor; o app compara com a chain e mostra **Transação bloqueada** com a diferença. Nada é assinado (a proposta vence em 10 min e é rejeitada on-chain).
5. **Trocar de aparelho**: Segurança → Trocar de aparelho → Gerar código → **Abrir como novo** (abre outra aba simulando o aparelho novo, com outra chave). No aparelho novo, crie um PIN. Volte à primeira aba → **Revisar e aprovar a troca** → PIN. O aparelho novo entra sozinho (pede o PIN dele); o antigo mostra "Chave trocada". Recarregue a aba antiga: "Esta chave foi substituída".
6. **Troca da chave do serviço**: no aparelho novo, "Simular pedido de troca da chave do serviço" → aprove (ou rejeite: nada muda).
7. **Atividade**: intenções e o registro de auditoria encadeado por hash.

Tudo fica em memória (API e surfpool): reiniciar `pnpm dev` zera as contas, e o app mostra "Conta não encontrada" com a opção de apagar a chave e começar de novo.

O app também abre no celular na mesma rede: `DK_WEB_HOST=0.0.0.0 pnpm dev` e acesse `http://<ip-do-notebook>:5173`. Só que o navegador do celular exige HTTPS para WebCrypto/IndexedDB fora de `localhost`, então isso precisa de um túnel HTTPS (ex.: `cloudflared tunnel --url http://localhost:5173`).

O design das telas está no Claude Design: https://claude.ai/artifact/TRkq2Zuv3qdEk1UicG9C5t

## O que está provado

`pnpm test` roda, contra o ELF do Squads v4 baixado da mainnet (sha256 em `fixtures/ORIGEM.md`):

```
CLIENT sozinho = impossível                 (Teste 1)
SERVER sozinho = impossível                 (Teste 2)
CLIENT + SERVER = possível                  (Teste 3)
trocar CLIENT exige CLIENT + SERVER         (Testes 6, 8)
trocar SERVER exige CLIENT + SERVER         (Testes 7, 9)
```

e mais: executor e wallet operacional não votam, replay, expiração, prova de posse, troca da chave nova depois da aprovação, servidor inteiro comprometido, app mostrando A com a chain tendo B, auditoria adulterada. Mapa completo em [docs/SECURITY_INVARIANTS.md](docs/SECURITY_INVARIANTS.md).

Três descobertas no programa mudaram o desenho pedido (detalhes em [docs/RESEARCH.md](docs/RESEARCH.md)):

1. **Adicionar e remover em passos separados é inseguro.** Com só a chave nova adicionada, há 3 votantes e threshold 2: as duas chaves do usuário movem fundos sem o servidor (o teste "PERIGO evitado" faz o roubo). A rotação é uma ConfigTransaction só, `[AddMember, RemoveMember]`.
2. **VaultTransaction aprovada continua executável depois da rotação.** Por isso a rotação drena a fila e para se achar aprovada pendente.
3. **Não há expiração on-chain**, mas em 2-de-2 um único voto de rejeição encerra a proposta. O servidor rejeita on-chain o que vence.

## Documentos

- [docs/RESEARCH.md](docs/RESEARCH.md) — Fase 1: versões, APIs usadas e o comportamento do programa
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — diagrama, fluxo, decisões de segurança (problema, alternativas, decisão)
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) — 22 ameaças com impacto, mitigação e risco residual
- [docs/KEY_ROTATION.md](docs/KEY_ROTATION.md) — rotação do cliente e do servidor, máquina de estados
- [docs/RECOVERY.md](docs/RECOVERY.md) — por que não há recuperação no v4 puro e os caminhos possíveis
- [docs/SECURITY_INVARIANTS.md](docs/SECURITY_INVARIANTS.md) — invariantes ↔ testes

## Estrutura

```
apps/api              Fastify: cadastro, sessão, intenções, decisão assinada, rotação
apps/approval-web     Approval App (React; WebCrypto Ed25519 não exportável; PIN/biometria)
packages/shared       intenção canônica (hash), schemas, erros
packages/crypto       Signer/ServerSigner, declarações off-chain assinadas
packages/solana       Chain (RPC | LiteSVM), leitor de instruções
packages/squads       estado on-chain, construtores, invariantes, derivação da intenção
packages/policy-engine política padrão
packages/custody      orquestração (servidor) e revisão/assinatura (app)
packages/database     Postgres (PgStore) + migração; PGlite nos testes
tests/                on-chain, protocolo, banco
fixtures/             ELF do Squads v4 e ProgramConfig da mainnet
```

## Outros comandos

```bash
pnpm typecheck                     # pacotes, API e app
pnpm smoke                         # fluxo completo via RPC (surfpool ou devnet) sem o app
pnpm fixtures                      # baixa de novo o ELF da Squads da mainnet
docker run -d --rm --name dk-pg -e POSTGRES_PASSWORD=dk -e POSTGRES_DB=dk -p 55432:5432 postgres:17-alpine
pnpm test:pg                       # protocolo inteiro num Postgres real (banco novo por teste)
DATABASE_URL=postgres://... pnpm dev   # API persistindo em Postgres
SOLANA_RPC_URL=https://api.devnet.solana.com SOLANA_CLUSTER=devnet pnpm dev   # devnet (o pagador precisa de SOL)
```

## Limites desta versão

- **Mainnet bloqueada**: as chaves do serviço são de desenvolvimento (memória ou arquivo cifrado). Precisa de KMS/HSM antes.
- **Modo estrito**: perder de vez o aparelho sem trocar a chave antes **bloqueia a conta**. Recuperação é pesquisa (RECOVERY.md), não código.
- App web, não nativo. No navegador, a biometria/PIN é uma trava da interface; no app nativo a trava passa a ser do Keystore/Keychain.
- Só transferência de SOL no app (o backend e o leitor já entendem TransferChecked de tokens). Swap fica para depois.
- Notificações são um mock que registra no log.
