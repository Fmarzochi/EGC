# Politica de Posicionamento e Procedencia de Skills

Este documento define onde ficam as skills geradas, importadas e curadas, como sao identificadas e o que e publicado.

## Tipos de Skill e Posicionamento

| Tipo | Caminho Raiz | Publicado | Procedencia |
|------|--------------|-----------|-------------|
| Curada | `skills/` (repositorio) | Sim | Nao obrigatoria |
| Aprendida | `~/.gemini/skills/learned/` | Nao | Obrigatoria |
| Importada | `~/.gemini/skills/imported/` | Nao | Obrigatoria |
| Evoluida | `~/.gemini/homunculus/evolved/skills/` (global) ou `projects/<hash>/evolved/skills/` (por projeto) | Nao | Herdada do instinto de origem |

Skills curadas ficam no repositorio em `skills/`. Manifestos de instalacao referenciam apenas caminhos curados. Skills geradas e importadas ficam no diretorio home do usuario e nunca sao publicadas.

## Skills Curadas

Localizacao: `skills/<nome-da-skill>/` com `SKILL.md` na raiz.

- Incluidas nos caminhos de `manifests/install-modules.json`.
- Validadas por `scripts/ci/validate-skills.js`.
- Sem arquivo de procedencia. Use `origin` no frontmatter do SKILL.md (egc, community) para atribuicao.

## Skills Aprendidas

Localizacao: `~/.gemini/skills/learned/<nome-da-skill>/`.

Criadas pelo aprendizado continuo (hook evaluate-session, comando /learn). O caminho padrao e configuravel via `skills/continuous-learning/config.json` → `learned_skills_path`.

- Nao estao no repositorio. Nao sao publicadas.
- Devem ter `.provenance.json` ao lado do `SKILL.md`.
- Carregadas em tempo de execucao quando o diretorio existe.

## Skills Importadas

Localizacao: `~/.gemini/skills/imported/<nome-da-skill>/`.

Skills instaladas pelo usuario de fontes externas (URL, copia de arquivo, etc.). Nao existe importador automatico ainda; o posicionamento e por convencao.

- Nao estao no repositorio. Nao sao publicadas.
- Devem ter `.provenance.json` ao lado do `SKILL.md`.

## Skills Evoluidas (Aprendizado Continuo v2)

Localizacao: `~/.gemini/homunculus/evolved/skills/` (global) ou `~/.gemini/homunculus/projects/<hash>/evolved/skills/` (por projeto).

- Nao estao no repositorio. Nao sao publicadas.
- Procedencia herdada dos instintos de origem; nenhum `.provenance.json` separado e necessario.

## Metadados de Procedencia

Obrigatorio para skills aprendidas e importadas. Arquivo: `.provenance.json` no diretorio da skill.

Campos obrigatorios:

| Campo | Tipo | Descricao |
|-------|------|-----------|
| source | string | Origem (URL, caminho ou identificador) |
| created_at | string | Timestamp ISO 8601 |
| confidence | number | 0 a 1 |
| author | string | Quem ou o que produziu a skill |

Schema: `schemas/provenance.schema.json`. Validacao: `scripts/lib/skill-evolution/provenance.js` → `validateProvenance`.

## Comportamento do Validador

### validate-skills.js

Escopo: Skills curadas apenas (`skills/` no repositorio).

- Se `skills/` nao existir: sair com 0 (nada para validar).
- Para cada subdiretorio: deve conter `SKILL.md`, nao vazio.
- Nao toca nas raizes de aprendidas/importadas/evoluidas.

### validate-install-manifests.js

Escopo: Somente caminhos curados. Todos os `paths` nos modulos devem existir no repositorio.

- Raizes geradas/importadas estao fora do escopo. Nenhum manifesto as referencia.
- Caminho ausente gera erro. Sem tratamento de caminho opcional.

### Scripts que Usam Raizes Geradas

`scripts/skills-health.js`, `scripts/lib/skill-evolution/health.js`, hooks de sessao: eles verificam `~/.gemini/skills/learned` e `~/.gemini/skills/imported`. Diretorios ausentes sao tratados como vazios; sem erros.

## Publicavel vs Somente Local

| Publicavel | Somente Local |
|------------|---------------|
| `skills/*` (curadas) | `~/.gemini/skills/learned/*` |
| | `~/.gemini/skills/imported/*` |
| | `~/.gemini/homunculus/**/evolved/**` |

Somente skills curadas aparecem nos manifestos de instalacao e sao copiadas durante a instalacao.

## Roteiro de Implementacao

1. Documento de politica e schema de procedencia (esta mudanca).
2. Adicionar validacao de procedencia aos caminhos de escrita de skills aprendidas (evaluate-session, saida /learn) para que novas skills aprendidas sempre gerem `.provenance.json`.
3. Atualizar o instinct-cli evolve para gravar procedencia opcional ao gerar skills evoluidas.
4. Adicionar `scripts/validate-provenance.js` ao CI para quaisquer caminhos do repositorio que nao devam conter conteudo aprendido/importado (se necessario).
5. Documentar raizes aprendidas/importadas no CONTRIBUTING.md ou em documentacao do usuario para que colaboradores saibam que nao devem commita-las.
