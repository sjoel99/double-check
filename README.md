# Dupla Chave

Custódia na Solana em que **nenhuma chave sozinha move fundos**. Os ativos ficam no Vault de uma multisig [Squads v4](https://github.com/Squads-Protocol/v4) **2 de 3**. Votam:

- a **Phantom** do usuário (ou outra carteira do Wallet Standard);
- a **chave do webapp**, gerada no aparelho e cifrada pela biometria dele (passkey com PRF); o serviço guarda só o texto cifrado;
- a **chave do serviço**, que só vota em trocas de chave, nunca em envios.

Só o **operador** do serviço executa, depois de conferir a política. Com os dois votos do usuário, nem a Phantom nem o webapp executam, o que está provado no programa real.

Trocar qualquer chave leva **72 h** e pode ser vetado ("Não fui eu") por quem ainda tem a chave que seria trocada. Perdeu o aparelho? A Phantom + o serviço recuperam o webapp. Perdeu a Phantom? A biometria + o serviço trocam a Phantom.

**O serviço não paga nada.** Taxas e rent saem da Phantom.

| | Custo para a Phantom |
|---|---|
| Criar a conta (uma vez) | ~0,003 SOL |
| Cada envio | 0,000015 SOL. Na hora, a Phantom precisa *ter* ~0,0065 SOL: o depósito das contas da Squads volta na mesma transação |
| Pedido de troca de chave | ~0,000015 SOL + ~0,006 SOL de depósito, que volta na conclusão |
| Depósito no Vault | 0,000005 SOL |
| Entrar | grátis (assinatura de texto) |

Quem garante isso é o programa da Squads. Backend, banco e webapp podem falhar sem que uma chave isolada mova fundos.

## Os fluxos

**Cadastro**
1. O webapp gera a chave do webapp e a cifra com a biometria deste aparelho.
2. O serviço prepara a criação da conta 2 de 3. O webapp confere a transação: só a criação, com os membros certos, sem nada escondido.
3. A chave do webapp e a Phantom assinam o memo de vínculo, e a Phantom paga (~0,003 SOL).

**Envio**
1. O usuário pede o envio. O serviço confere a política e simula; nada vai para a chain.
2. O webapp recebe a transação atômica, remonta sozinho a partir do que mostra e compara byte a byte.
3. **Biometria:** abre a chave do webapp, que assina esses bytes. O operador do serviço assina a execução.
4. A Phantom assina **uma vez** e paga. Se algo falhar, nada acontece na Solana.

**Troca de chave:** pedido (dois votos) → 72 h → concluir. Antes disso, "Não fui eu" cancela. Ver [docs/KEY_ROTATION.md](docs/KEY_ROTATION.md).

## Pelo celular (QR)

O QR do computador abre **o nosso webapp** no celular. Ali ele confere a transação e abre a chave do webapp com a biometria do celular. Depois chama a Phantom pelo Mobile Wallet Adapter (Android), que conecta e assina na mesma abertura. Para assinar, o celular nem precisa entrar na conta: o token do QR dá acesso àquela transação.

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

A biometria (passkey) fica presa ao domínio. O túnel muda a cada `pnpm dev:devnet`, então contas criadas num túnel não abrem a chave do webapp no túnel seguinte (só com "Recuperar o webapp"). Para testar com o celular, prefira o ambiente na VPS (`https://dupla.sjoel99.com`), com domínio fixo.

Em localnet (`pnpm dev`), há a **biometria de teste** e o botão **Abrir no celular de teste**, que abre o link do QR em outra aba. Assim dá para testar o caminho do QR sem aparelho.

## Testar agora

```bash
cd ~/Desenvolvimento/Pessoal/duplachave
pnpm install
pnpm test     # 67 testes, ~4 s, sem rede: o Squads v4 da mainnet rodando no LiteSVM
pnpm dev      # surfpool offline (Squads v4 das fixtures) + API :8787 + app :5173
```

Abra **http://127.0.0.1:5173**.

### Roteiro (5 minutos)

1. **Escolha a carteira.** Em localnet há duas **Carteiras de teste** (A e B) que imitam a janela da Phantom, e a **biometria de teste**, que imita a digital. O webapp pede SOL de teste, cria a chave do webapp (confirme a biometria) e a carteira assina a criação da conta (~0,003 SOL).
2. **Depositar:** "10 SOL no Vault" (ferramentas de teste) ou **Depositar** (a carteira paga).
3. **Enviar:** endereço e valor → **Revisar** → "Conferido…" → **Confirmar e assinar**. A biometria abre a chave do webapp, o operador assina e a carteira assina uma vez. Em "Ou continuar no celular (QR)" → **Abrir no celular de teste**, outra aba faz o papel do celular.
4. **Servidor malicioso:** marque a opção e faça outro envio. O servidor mostra 1/10 do valor; o webapp remonta a transação, vê que não bate e mostra **Transação bloqueada** com o valor real.
5. **Recuperar o webapp:** Segurança → **Recuperar o webapp neste aparelho**. A biometria cria a chave nova e a carteira vota e paga. Em localnet o prazo é **2 min** (`pnpm dev`; na VPS, 72 h). A tela inicial avisa da troca pendente; depois do prazo, **Concluir troca**.
6. **Não fui eu:** peça outra recuperação e toque em **Não fui eu**: a biometria (chave atual do webapp) veta.
7. **Perdeu a Phantom:** Sair → **Perdeu a Phantom? Entrar com a biometria** → Segurança → **Trocar a Phantom** com a Carteira de teste B (que precisa de SOL).

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

- **Webapp adulterado:** a chave do webapp fica aberta no navegador durante a assinatura. Quem controla o código que o navegador roda (serviço comprometido servindo o webapp) pode capturá-la; com o voto do serviço, são 2 votos. Endurecimento: hospedar o webapp separado do serviço. Ver THREAT_MODEL #31.
- **PRF obrigatória:** o aparelho precisa entregar a PRF da passkey (Chrome no Android com o gerenciador de senhas do Google). Teste em `/#/prf`.
- **Perder a Phantom e todos os aparelhos** bloqueia a conta: são dois votos do usuário perdidos.
- **Alertas simulados:** pedidos e vetos de troca só vão para o log; o webapp mostra o aviso na tela inicial. Falta o canal real (Telegram/e-mail).
- **Mainnet bloqueada:** as chaves do serviço são de desenvolvimento; é preciso KMS/HSM antes.
- **Só transferência de SOL.** Swap fica para depois.
- **Mobile Wallet Adapter só no Android.**
