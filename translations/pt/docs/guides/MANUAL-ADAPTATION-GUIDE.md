# Guia de Adaptacao Manual para Harnesses Nao Nativos

Use este guia quando quiser comportamento egc dentro de um harness que nao carrega nativamente layouts `.gemini/`, `.codex/`, `.opencode/`, `.cursor/` ou `.agent/`.

Este e o caminho alternativo para ferramentas como Grok e outras interfaces estilo chat que podem aceitar prompts de sistema, arquivos enviados ou instrucoes coladas, mas nao podem executar as superficies de instalacao nativas do repositorio diretamente.

## Quando Usar

Use adaptacao manual quando o harness alvo:

- nao carrega pastas do repositorio automaticamente
- nao suporta comandos slash customizados
- nao suporta hooks
- nao suporta ativacao de skill local do repositorio
- tem acesso parcial ou nenhum acesso ao sistema de arquivos/ferramentas

Prefira um target egc de primeira classe sempre que um existir:

- Gemini Code
- Codex
- Cursor
- OpenCode
- CodeBuddy
- Antigravity

Use este guia somente quando precisar de comportamento egc em um harness nao nativo.

## O que Voce Esta Reproduzindo

Quando voce adapta o egc manualmente, esta tentando preservar quatro coisas:

1. Contexto focado em vez de despejar o repositorio inteiro.
2. Sinalizadores de ativacao de skill em vez de esperar que o modelo adivinhe o fluxo de trabalho.
3. Intencao de comando mesmo quando o harness nao tem sistema de slash-command.
4. Disciplina de hook mesmo quando o harness nao tem automacao nativa.

Voce nao esta tentando espelhar todos os arquivos no repositorio. Voce esta tentando recriar o comportamento util com o menor bundle de contexto possivel.

## O Fallback Nativo do egc

Padronize para selecao manual do proprio repositorio.

Comece com apenas os arquivos que realmente precisa:

- uma skill de linguagem ou framework
- uma skill de fluxo de trabalho
- uma skill de dominio se a tarefa for especializada
- um agente ou comando somente se o harness se beneficia de orquestracao explicita

Bons exemplos minimos:

- Trabalho com feature Python:
  - `skills/python-patterns/SKILL.md`
  - `skills/tdd-workflow/SKILL.md`
  - `skills/verification-loop/SKILL.md`
- Trabalho com API TypeScript:
  - `skills/backend-patterns/SKILL.md`
  - `skills/security-review/SKILL.md`
  - `skills/tdd-workflow/SKILL.md`
- Trabalho com conteudo/outbound:
  - `skills/brand-voice/SKILL.md`
  - `skills/content-engine/SKILL.md`
  - `skills/crosspost/SKILL.md`

Se o harness suportar upload de arquivo, envie apenas esses arquivos.

Se o harness suportar apenas contexto colado, extraia as secoes relevantes e cole um bundle comprimido em vez dos arquivos completos brutos.

## Empacotamento Manual de Contexto

Voce nao precisa de ferramentas extras para fazer isso.

Use o repositorio diretamente:

```bash
cd /path/to/EGC

sed -n '1,220p' skills/tdd-workflow/SKILL.md > /tmp/egc-context.md
printf '\n\n---\n\n' >> /tmp/egc-context.md
sed -n '1,220p' skills/backend-patterns/SKILL.md >> /tmp/egc-context.md
printf '\n\n---\n\n' >> /tmp/egc-context.md
sed -n '1,220p' skills/security-review/SKILL.md >> /tmp/egc-context.md
```

Voce tambem pode usar `rg` para identificar as skills certas antes de empacotar:

```bash
rg -n "When to use|Use when|Trigger" skills -g 'SKILL.md'
```

Opcional: se voce ja usa um empacotador de repositorio como `repomix`, ele pode ajudar a comprimir arquivos selecionados em um unico documento de entrega. E uma ferramenta de conveniencia, nao o caminho canonico do egc.

## Regras de Compressao

Ao empacotar manualmente o egc para outro harness:

- mantenha o enquadramento da tarefa
- mantenha as condicoes de ativacao
- mantenha as etapas do fluxo de trabalho
- mantenha os exemplos criticos
- remova prosa repetitiva primeiro
- remova variantes nao relacionadas em segundo lugar
- evite colar diretorios inteiros quando uma ou duas skills forem suficientes

Se precisar de um formato de prompt mais compacto, converta as partes essenciais em um bloco estruturado compacto:

```xml
<skill name="tdd-workflow">
  <when>Nova feature, correcao de bug ou refatoracao que deve ser test-first.</when>
  <steps>
    <step>Escreva um teste que falha.</step>
    <step>Faca ele passar com a menor mudanca possivel.</step>
    <step>Refatore e re-execute a validacao.</step>
  </steps>
</skill>
```

## Reproduzindo Comandos

Se o harness nao tem sistema de slash-command, defina um pequeno registro de comandos no prompt de sistema ou preambulo de sessao.

Exemplo:

```text
Registro de comandos:
- /plan -> use raciocinio estilo planner, produza um plano de execucao curto, depois aja
- /tdd -> siga a skill tdd-workflow
- /review -> mude para modo de revisao de codigo e enumere os achados primeiro
- /verify -> execute um loop de verificacao antes de declarar conclusao
```

Voce nao esta implementando comandos reais. Voce esta dando ao harness handles de invocacao explicitos que mapeiam para comportamentos do egc.

## Reproduzindo Hooks

Se o harness nao tem hooks nativos, mova a intencao do hook para as instrucoes permanentes.

Exemplo:

```text
Antes de escrever codigo:
1. Verifique se uma skill relevante deve ser ativada.
2. Verifique se ha mudancas sensiveis de seguranca.
3. Prefira testes antes da implementacao quando viavel.

Antes de finalizar:
1. Releia a requisicao do usuario.
2. Verifique os principais caminhos alterados.
3. Declare o que foi realmente validado e o que nao foi.
```

Isso nao recria automacao real, mas captura a disciplina operacional do egc.

## Matriz de Capacidades do Harness

| Capacidade | Targets Nativos egc | Targets de Adaptacao Manual |
| --- | --- | --- |
| Instalacao baseada em pasta | Nativa | Nao |
| Slash commands | Nativa | Simulada no prompt |
| Hooks | Nativa | Simulada no prompt |
| Ativacao de skill | Nativa | Manual |
| Ferramentas locais do repositorio | Nativa | Depende do harness |
| Empacotamento de contexto | Opcional | Obrigatorio |

## Configuracao Pratica Estilo Grok

1. Escolha o menor bundle util.
2. Empacote os arquivos de skill egc selecionados em um upload ou bloco colado.
3. Adicione um registro de comando curto.
4. Adicione instrucoes de "intencao de hook" permanentes.
5. Comece com uma tarefa e verifique se o harness segue o fluxo de trabalho antes de escalar.

Preambulo de exemplo:

```text
Voce esta operando com um bundle egc adaptado manualmente.

Skills ativas:
- backend-patterns
- tdd-workflow
- security-review

Registro de comandos:
- /plan
- /tdd
- /verify

Antes de escrever codigo, siga as instrucoes da skill ativa.
Antes de finalizar, verifique o que mudou e relate as lacunas restantes.
```

## Limitacoes

A adaptacao manual e util, mas ainda e de segunda classe em comparacao com os targets nativos.

Voce perde:

- instalacao e sincronizacao automaticas
- execucao nativa de hook
- plumbing real de comandos
- descoberta confiavel de skills em tempo de execucao
- orquestracao integrada de multi-agente/worktree

Portanto, a regra e simples:

- use adaptacao manual para levar comportamento egc para harnesses nao nativos
- use targets nativos egc sempre que quiser o sistema completo

## Trabalho Relacionado

- [Issue #1186](https://github.com/Fmarzochi/EGC-code/issues/1186)
- [Discussao #1077](https://github.com/Fmarzochi/EGC-code/discussions/1077)
- [Guia Antigravity](./ANTIGRAVITY-GUIDE.md)
- [Solucao de Problemas](./TROUBLESHOOTING.md)
