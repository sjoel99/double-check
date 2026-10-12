# Recuperação (RECOVERY_POLICY) — pesquisa e proposta

> **Nota (2026-10):** este documento é do modelo **2 de 2** (carteira + serviço) e fica como registro da pesquisa. Ele **não descreve o sistema atual**. Hoje a conta é uma multisig **2 de 3** (Phantom, chave do webapp destravada pela biometria e serviço), só o operador do serviço executa, e a recuperação é uma troca de chave com prazo de 72 h e veto ("Não fui eu"), imposto pelo operador. Ver [ARCHITECTURE.md](ARCHITECTURE.md) (D15–D18) e [KEY_ROTATION.md](KEY_ROTATION.md). Os nomes citados abaixo (`STRICT_2_OF_2`, `RotationRecord`, `ServerKeyProvider` como ponto de extensão etc.) são da época; `RotationRecord` não existe mais no código.

Status na época: **não implementado**. O modo era `STRICT_2_OF_2`: perder de vez uma das duas chaves bloqueava a conta. Este documento registra por que não há atalho no Squads v4 puro e quais caminhos existiam.

## O requisito

Permitir recuperar a conta com CLIENT perdido (ou SERVER perdido) **sem** criar uma chave que, sozinha ou com só um dos outros lados, mova fundos normalmente.

## Por que não "2-de-3 com RECOVERY"

O Squads v4 tem **um** threshold entre todos os votantes, usado para tudo: VaultTransaction e ConfigTransaction. Com CLIENT, SERVER e RECOVERY votando e threshold 2:

- RECOVERY + SERVER movem fundos sem o usuário → fere a invariante 3;
- RECOVERY + CLIENT movem fundos sem a política do servidor → fere a invariante 4;
- o recovery signer deixa de ser "só de recuperação" e vira um terceiro aprovador de qualquer coisa.

Threshold 3 com três votantes resolve isso, mas aí perder qualquer uma das três trava a conta — piorou.

**Limitação do v4, sem disfarce**: o programa não expressa "para transações financeiras: CLIENT e SERVER; para recuperação: outra regra". Não há threshold por tipo de transação, e o `time_lock` é global (valeria também para todo envio). A `config_authority` muda membros instantaneamente, sem prazo e sem veto.

## Opções

### A. Recovery signer offline + timelock (v4 puro)

Não funciona no v4: o time lock é global (atrasaria todo envio) e o recovery signer precisaria ser votante (cai no problema acima).

### B. Squads Smart Account Program (programa novo da Squads)

- Programa `SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG`, v0.1, upgradeable, auditado (OtterSec, Certora com verificação formal). O SDK `@sqds/smart-account` **não está publicado no npm** (2026-09-30).
- Tem **policies** com signers, threshold e `time_lock` próprios por policy. A policy `SettingsChange` pode permitir só `RemoveSigner`/`AddSigner`.
- Desenho possível: consenso principal CLIENT + SERVER (threshold 2) para tudo; policy de recuperação com o guardião, threshold 1 e `time_lock` de N dias, restrita a trocar o CLIENT. O veto durante o prazo seria CLIENT + SERVER executando `PolicyUpdate`/`PolicyRemove`, que invalida as pendentes da policy.
- Riscos: guardião + servidor juntos conseguem tomar a conta (trade-off de qualquer recuperação); `AddSigner{new_signer: None}` deixa o guardião escolher qualquer chave nova; não usar expiração `SettingsState` na policy (morreria na primeira rotação); programa jovem e upgradeable por chave da Squads.
- **É o caminho mais promissor**, mas significa migrar de programa. Esperar o SDK publicado e uma versão estável.

### C/D. Programa próprio como `config_authority`

Um programa pequeno ("dk-recovery") vira a `config_authority` da multisig (PDA). Consequências do v4: a multisig passa a ser "controlada" — `config_transaction_create` deixa de funcionar e **toda** mudança de membros passa por esse programa, inclusive as rotações normais. O programa então precisa codificar as duas regras:

- rotação normal: exige assinatura de CLIENT e SERVER atuais (lidos da multisig);
- recuperação: guardião inicia, prazo de N dias, CLIENT ou SERVER atuais podem cancelar; só troca o membro perdido.

Problema grave: a `config_authority` do v4 também pode **adicionar spending limit** (`multisig_add_spending_limit`) e mudar threshold. O programa nunca pode expor isso, e um bug nele vira perda de fundos. É um programa novo de custódia, sem auditoria — o oposto do motivo de usar a Squads.

### E. Guardião + timelock longo + cancelamento pelo usuário

É o comportamento desejado, e é exatamente o que B (policy com time lock) e C/D (programa próprio) implementam. No v4 puro não existe.

## Recomendação

1. Manter `STRICT_2_OF_2` agora e deixar a UX clara: "perder este aparelho sem trocar a chave antes bloqueia a conta" (já está na tela de Segurança e no cadastro).
2. Reduzir a chance de perda sem mexer no modelo: incentivar a troca de aparelho antes de trocar o celular; permitir mais de um aparelho? **Não** — dois aparelhos do usuário votando com threshold 2 voltariam ao problema de dois votos do mesmo lado.
3. Prototipar B em devnet quando o SDK sair, com os testes de invariantes portados: guardião sozinho não move fundos; guardião + servidor só trocam o CLIENT depois do prazo e sem veto; CLIENT + SERVER vetam.
4. O código já tem os pontos de extensão: `RotationRecord`/máquina de estados (nova origem `RECOVERY`), `ServerKeyProvider` (servidor perdido = recriar dentro do KMS, que tem a própria recuperação), `NotificationService` (avisos fora de banda durante o prazo).

## Servidor perdido

Com KMS/HSM, "perder a chave do servidor" é perder o KMS — evento de infraestrutura com recuperação própria (backup do HSM, réplica multi-região). Sem KMS (dev), perder `DK_KEY_ENCRYPTION_KEY` ou `DK_KEYS_DIR` **bloqueia todas as contas**. Por isso a mainnet está desabilitada nesta versão.
