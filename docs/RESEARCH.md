# Fase 1 — Pesquisa: Squads v4, SDK e o que isso impõe ao desenho

> **Nota (2026-10):** esta pesquisa foi feita na fase **2 de 2** (carteira + serviço). Os comportamentos do programa (itens 1–13) continuam valendo; as decisões da tabela "Limitações que viraram decisões" e a seção sobre a chave no celular são daquela fase. O desenho atual (2 de 3, operador único executor, trocas com prazo de 72 h e veto, chave do webapp cifrada pela PRF da passkey) está em [ARCHITECTURE.md](ARCHITECTURE.md); os testes citados por nome e que não existem mais eram do modelo 2 de 2 (ver o histórico do git, commit `b210c7a`).

Data: 2026-09-30. Fontes: código do programa (`github.com/Squads-Protocol/v4`, commit `af94153`, ago/2026), o ELF implantado na mainnet (baixado por `pnpm fixtures`, ver `fixtures/ORIGEM.md`), o SDK `@sqds/multisig@2.1.4` (última versão no npm, `latest`), docs da Apple, do Android/AOSP e da Squads. Os testes rodam contra **o binário da mainnet**, não contra uma leitura da documentação: o que está escrito aqui e tem teste foi verificado pelo programa.

## Versões usadas

| Peça | Versão | Observação |
|---|---|---|
| Programa Squads v4 | `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`, último deploy no slot 302582236 | sha256 do ELF em `fixtures/ORIGEM.md` |
| `@sqds/multisig` | 2.1.4 (`latest` no npm, ago/2025) | usa `@solana/web3.js` 1.x |
| `@solana/web3.js` | 1.98 | o SDK da Squads ainda não fala `@solana/kit`; misturar os dois exigiria conversões em toda a borda |
| LiteSVM (testes) | 0.8.0 | última versão com web3.js 1.x (a 1.x usa `@solana/kit`) |
| surfpool (dev) | 1.1.2 | validador local; por padrão **offline**, com o ELF da Squads carregado das fixtures (`SURFPOOL_FORK=1` faz fork da mainnet); airdrop livre |

## APIs do SDK usadas

`instructions.multisigCreateV2`, `vaultTransactionCreate`, `proposalCreate`, `proposalApprove`, `proposalReject`, `proposalCancel`, `vaultTransactionExecute`, `configTransactionCreate`, `configTransactionExecute`; `accounts.Multisig`, `Proposal`, `VaultTransaction`, `ConfigTransaction`, `ProgramConfig`; `getMultisigPda`, `getVaultPda`, `getTransactionPda`, `getProposalPda`, `getProgramConfigPda`; `types.Permission`/`Permissions`.

Nada de `multisigAddMember`/`multisigRemoveMember`/`multisigChangeThreshold`/`multisigSetConfigAuthority`/`multisigAddSpendingLimit`: essas instruções só existem para multisig **controlada** (com `config_authority`), que este sistema proíbe.

## Comportamentos do programa que definem o desenho

Cada item cita onde está no código e qual teste o prova (`tests/onchain.test.ts`, salvo indicação).

1. **Permissões são uma máscara**: Initiate = 1, Vote = 2, Execute = 4 (`state/multisig.rs`). Votar exige Vote (`proposal_vote.rs`); criar VaultTransaction/ConfigTransaction exige Initiate; criar Proposal aceita Initiate **ou** Vote; executar exige Execute. *Testes 4 e 5.*
2. **Threshold conta só votantes.** O `invariant()` exige `threshold ≤ número de votantes`, pelo menos um Initiate, um Execute e um Vote, e sem membros duplicados. Ele roda no fim de toda instrução que altera a multisig. *Teste "threshold acima do número de votantes".*
3. **`config_authority`**: se diferente de `Pubkey::default()`, a multisig é "controlada" e essa chave muda membros, threshold e time lock **sozinha e na hora**, sem proposta; `config_transaction_create` passa a falhar. Este sistema exige `config_authority = default` e confere isso na chain antes de toda decisão (`assertAccountModel`).
4. **Spending limits contornam o quórum.** `AddSpendingLimit` (ação de ConfigTransaction) cria uma conta que permite a membros listados moverem até um valor por período **sem votação** (`spending_limit_use.rs`), e sem time lock. A política recusa qualquer ConfigTransaction com essa ação.
5. **Ações de uma ConfigTransaction executam em ordem e o invariant só roda no fim** (`config_transaction_execute.rs`). Por isso `[AddMember(nova), RemoveMember(antiga)]` numa transação só troca a chave sem nenhum estado intermediário na chain. *Testes 8 e 9.*
6. **Mudança de membros/threshold/time lock torna stale tudo o que veio antes** (`invalidate_prior_transactions`: `stale_transaction_index = transaction_index`). Proposta stale não recebe voto nem é executada — **exceto VaultTransaction já aprovada**: `vault_transaction_execute.rs` diz explicitamente que aprovadas antes de ficarem stale continuam executáveis. *Testes "rotação torna stale" e "ATENÇÃO: aprovada continua executável".*
7. **Cancelar** só vale para proposta `Approved` e precisa de `threshold` votos de cancelamento; votos de quem deixou de ser membro são descartados (`cancelled.retain(is_member)`). Em 2-de-2, os dois cancelam. *Teste "CLIENT_B + SERVER cancelam a aprovada antiga".*
8. **Rejeitar**: `cutoff = votantes − threshold + 1`. Em 2-de-2 o cutoff é 1: **um único voto de rejeição encerra a proposta**. É isso que torna a expiração aplicável na chain (o servidor rejeita o que venceu). *Teste "um único voto de rejeição".*
9. **Não existe expiração on-chain.** Uma proposta ativa fica ativa para sempre, e uma aprovada fica executável para sempre (até ser executada ou cancelada). Validade é regra deste sistema, aplicada fora da chain e materializada por rejeição.
10. **`time_lock` é global**: vale igual para VaultTransaction e ConfigTransaction, contado a partir da aprovação (máximo 3 meses). Não dá para ter um prazo só para mudanças de segurança.
11. **O conteúdo de uma transação é imutável e o índice não se repete.** A conta VaultTransaction/ConfigTransaction não muda depois de criada; `transaction_index` só cresce. Por isso o hash da conta identifica para sempre o que está sendo votado. **Mas o voto (`proposal_approve`) referencia só o índice, não o conteúdo** — daí a regra do app de conferir o conteúdo na chain antes de assinar.
12. **`memo`** em `vault_transaction_create`, `config_transaction_create` e `proposal_approve`: campo livre gravado no log, não verificado pelo programa. O sistema grava, para auditoria, `dk1:<32 primeiros hex do hash da intenção>` no `vault_transaction_create` dos envios e `dk1:troca:<id>` no `config_transaction_create` das trocas; o `proposal_approve` vai sem memo.
13. **Membros ficam ordenados e a busca é binária**; o programa reordena ao adicionar.

## Limitações que viraram decisões (detalhes em ARCHITECTURE.md)

| Limitação | Consequência | Decisão |
|---|---|---|
| Adicionar e remover em transações separadas cria 3 votantes com threshold 2 | CLIENT_A + CLIENT_B movem fundos sem o servidor (provado em teste) | Rotação é **uma** ConfigTransaction `[AddMember, RemoveMember]` |
| Aprovada continua executável depois da rotação | Uma aprovação feita com a chave antiga sobrevive à troca | Antes de rotacionar: rejeitar ativas; aprovada pendente **bloqueia** a rotação (`ROLLBACK_REQUIRED`) |
| Sem expiração on-chain | Proposta esquecida pode ser aprovada dias depois | Servidor recusa e **rejeita on-chain** o que venceu (cutoff 1) |
| Threshold único entre votantes | Não dá para dizer "financeiro: CLIENT e SERVER; recuperação: outra regra" | Modo `STRICT_2_OF_2` agora; recuperação exige programa/política extra (RECOVERY.md) |
| Time lock global | Um prazo para recuperação atrasaria todo envio | Time lock = 0 |

## Chave Ed25519 no celular (resumo; fontes em RECOVERY.md/ARCHITECTURE.md)

- **iOS**: o Secure Enclave não tem Ed25519 (só P-256 e, desde o iOS 26, ML-KEM/ML-DSA). `CryptoKit.Curve25519` roda em software; a Apple recomenda guardar a chave no Keychain. Caminho: seed no Keychain com `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` + `SecAccessControl(.biometryCurrentSet)`.
- **Android**: KeyMint v2 (Android 13+) suporta Ed25519 **no TEE** com chave não exportável (`KeyPairGenerator.getInstance("Ed25519", "AndroidKeyStore")` + `ECGenParameterSpec("ed25519")`); o StrongBox não suporta. Exige módulo nativo próprio e fallback para aparelhos sem KeyMint ≥ 2.
- **Passkeys**: o precompile secp256r1 (SIMD-0075) está ativo na mainnet, mas o Squads v4 exige que o membro assine a transação como `Signer` Ed25519. Passkey não pode ser membro direto do v4.
- **Navegador** (fase 2 de 2): WebCrypto Ed25519 com `extractable: false` — o navegador recusa exportar a chave privada; o `CryptoKey` fica no IndexedDB. Chrome 137+, Firefox 129+, Safari 17+. **Hoje** a chave do webapp é uma semente Ed25519 cifrada (AES-256-GCM) com uma chave derivada (HKDF) da PRF da passkey; o serviço guarda só o texto cifrado (ARCHITECTURE.md, D15).
