# Recomendacoes de Melhorias Arquiteturais

Este documento captura melhorias em nivel de arquiteto para o projeto EGC - Extended Global Context. E escrito da perspectiva de um arquiteto de codificacao do EGC visando melhorar a manutenibilidade, consistencia e qualidade de longo prazo.

---

## 1. Documentacao e Fonte Unica de Verdade

### 1.1 Sincronizacao de Contagem de Agentes / Comandos / Skills

**Problema:** AGENTS.md declara "13 agentes especializados, 50+ skills, 33 comandos" enquanto o repositorio tem **16 agentes**, **65+ skills** e **40 comandos**. README e outros docs tambem variam. Isso causa confusao para colaboradores e usuarios.

**Recomendacao:**

- **Fonte unica de verdade:** Derivar contagens (e opcionalmente tabelas) do sistema de arquivos ou de um manifesto pequeno. Opcoes:
  - **Opcao A:** Adicionar um script (ex.: `scripts/ci/catalog.js`) que escaneia `agents/*.md`, `commands/*.md` e `skills/*/SKILL.md` e gera saida JSON/Markdown. CI e docs podem consumir isso.
  - **Opcao B:** Manter um `docs/catalog.json` (ou YAML) que lista agentes, comandos e skills com metadados; scripts e docs lem dele. Requer disciplina para atualizar em adicoes/remocoes.
- **Curto prazo:** Sincronizar manualmente AGENTS.md, README.md e gemini.md com as contagens reais e listar quaisquer novos agentes (ex.: chief-of-staff, loop-operator, harness-optimizer) na tabela de agentes.

**Impacto:** Alto: afeta a primeira impressao e a confianca dos colaboradores.

---

### 1.2 Mapa Comando -> Agente / Skill

**Problema:** Nao existe um mapa unico legivel por maquina ou humano de "qual comando usa qual(is) agente(s) ou skill(s)." Isso vive em tabelas do README e em arquivos `.md` de comandos individuais, que podem divergir.

**Recomendacao:**

- Adicionar um **registro de comandos** (ex.: em `docs/` ou como frontmatter em arquivos de comando) que liste para cada comando: nome, descricao, agente(s) principal(is), skills referenciadas. Pode ser gerado do conteudo de arquivos de comando ou mantido manualmente.
- Expor um "mapa" em docs (ex.: `docs/COMMAND-AGENT-MAP.md`) ou no catalogo gerado para descobribilidade e para ferramentas (ex.: "quais comandos usam tdd-guide?").

**Impacto:** Medio: melhora a descobribilidade e a seguranca de refatoracao.

---

## 2. Testes e Qualidade

### 2.1 Descoberta de Testes vs Lista Hardcoded

**Problema:** `tests/run-all.js` usa uma **lista hardcoded** de arquivos de teste. Novos arquivos de teste nao sao executados a menos que alguem atualize `run-all.js`, entao a cobertura pode estar incompleta por omissao.

**Recomendacao:**

- **Descoberta baseada em glob:** Descobrir arquivos de teste por padrao (ex.: `**/*.test.js` em `tests/`) e executa-los, com uma allowlist/denylist opcional para casos especiais. Isso faz com que novos testes sejam automaticamente parte do suite.
- Manter um unico ponto de entrada (`tests/run-all.js`) que executa testes descobertos e agrega resultados.

**Impacto:** Alto: evita regressoes onde novos testes existem mas nunca sao executados.

---

### 2.2 Metricas de Cobertura de Testes

**Problema:** Nao ha ferramenta de cobertura (ex.: nyc/c8/istanbul). O projeto nao pode afirmar "80%+ de cobertura" para seus proprios scripts; a cobertura e implicita.

**Recomendacao:**

- Introduzir uma ferramenta de cobertura para scripts Node (ex.: `c8` ou `nyc`) e executa-la no CI. Comece com uma baseline (ex.: 60%) e aumente com o tempo; ou pelo menos relate a cobertura no CI sem falhar para que a equipe possa ver tendencias.
- Focar em `scripts/` (lib + hooks + ci) como o alvo principal; excluir scripts avulsos se necessario.

**Impacto:** Medio: alinha o projeto com sua propria orientacao do AGENTS.md (80%+ de cobertura) e expoe caminhos nao testados.

---

## 3. Schema e Validacao

### 3.1 Usar Schema JSON de Hooks no CI

**Problema:** `schemas/hooks.schema.json` existe e define a forma da configuracao de hooks, mas `scripts/ci/validate-hooks.js` **nao o usa**. A validacao e duplicada (VALID_EVENTS, estrutura) e pode divergir do schema.

**Recomendacao:**

- Usar um validador de JSON Schema (ex.: `ajv`) em `validate-hooks.js` para validar `hooks/hooks.json` contra `schemas/hooks.schema.json`. Manter o validador como a fonte unica de verdade para estrutura; reter apenas verificacoes especificas de hook (ex.: sintaxe JS inline) no script.
- Garante que schema e validador permanecam sincronizados e permite validacao em IDE/editor via `$schema` em hooks.json.

**Impacto:** Medio: reduz divergencias e melhora a experiencia do colaborador ao editar hooks.

---

## 4. Entre Harnesses e i18n

### 4.1 Sincronizacao de Subconjunto de Skills/Agentes (.agents/skills, .cursor/skills)

**Problema:** `.agents/skills/` (Codex) e `.cursor/skills/` sao subconjuntos de `skills/`. Adicionar ou remover uma skill no repositorio principal requer atualizar manualmente esses subconjuntos, o que pode ser esquecido.

**Recomendacao:**

- Documentar no CONTRIBUTING.md que adicionar uma skill pode requerer atualizar `.agents/skills` e `.cursor/skills` (e como fazer isso).
- Opcionalmente: uma verificacao no CI ou script que compara `skills/` com os subconjuntos e falha ou avisa se uma skill esta em um conjunto mas nao no outro quando deveria estar (ex.: por convencao ou por um pequeno manifesto).

**Impacto:** Baixo a Medio: reduz divergencias entre harnesses.

---

### 4.2 Deriva de Traducao (docs/ zh-CN, zh-TW, ja-JP)

**Problema:** Traducoes em `docs/` duplicam agentes, comandos e skills. Conforme o source em ingles evolui, as traducoes podem ficar desatualizadas sem um processo ou ferramentas claras.

**Recomendacao:**

- Documentar um **processo de traducao:** quando atualizar (ex.: em cada release), quem possui cada locale, e como detectar conteudo obsoleto (ex.: diff de listas de arquivos ou secoes-chave).
- Considerar: arquivo de status de traducao (ex.: `docs/i18n-status.md`) ou CI que verifica existencia/timestamps de arquivos de traducao e avisa se o ingles foi atualizado mais recentemente do que uma traducao.
- A longo prazo: considerar formato de extracao/placeholder (ex.: chaves i18n) para que as traducoes referenciem a mesma estrutura que o source em ingles.

**Impacto:** Medio: melhora a experiencia para usuarios nao falantes de ingles e reduz confusao com traducoes desatualizadas.

---

## 5. Hooks e Scripts

### 5.1 Consistencia de Runtime de Hook

**Problema:** Hooks devem manter uma superficie de despacho Node consistente. A observacao de aprendizado continuo agora despacha por meio de `run-with-flags.js` e `observe-runner.js`, que delega a implementacao existente de `observe.sh` sem expor uma entrada de hook em modo shell.

**Recomendacao:**

- Preferir Node para novos hooks quando possivel (multiplataforma, runtime unico). Se shell for necessario, documente o motivo e mantenha a superficie pequena.
- Garantir que `egc_HOOK_PROFILE` e `egc_DISABLED_HOOKS` sejam respeitados em todos os caminhos de codigo (incluindo shell) para que o comportamento seja consistente.

**Impacto:** Baixo: mantem o design atual; melhora se mais hooks migrarem para Node.

---

## 6. Tabela Resumo

| Area | Melhoria | Prioridade | Esforco |
|------|----------|------------|---------|
| Sync de docs | Sincronizar contagens/tabela do AGENTS.md/README | Alto | Baixo |
| Fonte unica | Script de catalogo ou manifesto | Alto | Medio |
| Descoberta de testes | Runner de testes baseado em glob | Alto | Baixo |
| Cobertura | Adicionar c8/nyc e cobertura no CI | Medio | Medio |
| Schema de hook no CI | Validar hooks.json via schema | Medio | Baixo |
| Mapa de comandos | Registro de comando -> agente/skill | Medio | Medio |
| Sync de subconjunto | Documentar/CI para .agents/.cursor | Baixo a Med | Baixo a Med |
| Traducoes | Processo + deteccao de obsolescencia | Medio | Medio |
| Runtime de hook | Preferir Node; documentar uso de shell | Baixo | Baixo |

---

## 7. Ganhos Rapidos (Imediatos)

1. **Atualizar AGENTS.md:** Definir contagem de agentes para 16; adicionar chief-of-staff, loop-operator, harness-optimizer a tabela de agentes; alinhar contagens de skills/comandos com o repositorio.
2. **Descoberta de testes:** Alterar `run-all.js` para descobrir `**/*.test.js` em `tests/` (com allowlist opcional) para que novos testes sejam sempre executados.
3. **Conectar schema de hooks:** Em `validate-hooks.js`, validar `hooks/hooks.json` contra `schemas/hooks.schema.json` usando ajv (ou similar) e manter apenas verificacoes especificas de hook no script.

Esses tres podem ser feitos em uma ou duas sessoes e melhoram materialmente a consistencia e a confiabilidade.
