# Solucao de Problemas

Solucoes de contorno relatadas pela comunidade para bugs atuais do Gemini Code que podem afetar usuarios do egc.

Esses sao comportamentos do Gemini Code upstream, nao bugs do egc. As entradas abaixo resumem as solucoes testadas em producao coletadas na [issue #644](https://github.com/Fmarzochi/EGC-code/issues/644) no Gemini Code `v2.1.79` (macOS, uso intenso de hooks, conectores MCP habilitados). Trate-as como solucoes temporarias pragmaticas ate que as correcoes upstream cheguem.

## Solucoes de Contorno da Comunidade para Bugs Abertos do Gemini Code

### Rotulos falsos de "Hook Error" em hooks que funcionaram com sucesso

**Sintomas:** O hook e executado com sucesso, mas o Gemini Code ainda mostra `Hook Error` no transcript.

**O que ajuda:**

- Consumir stdin no inicio do hook (`input=$(cat)` em hooks shell) para que o processo pai nao veja um pipe nao consumido.
- Para hooks simples de permitir/bloquear, enviar diagnosticos legiveis por humanos para stderr e manter stdout silencioso, a menos que sua implementacao de hook exija explicitamente stdout estruturado.
- Redirecionar stderr de processos filhos barulhentos quando nao e acionavel.
- Usar os codigos de saida corretos: `0` permite, `2` bloqueia, outros valores nao-zero sao tratados como erros.

**Exemplo:**

```bash
# Bom: bloquear com mensagem no stderr e sair com 2
input=$(cat)
echo "[BLOCKED] Motivo aqui" >&2
exit 2
```

### Compactacao mais cedo do que o esperado com `gemini_AUTOCOMPACT_PCT_OVERRIDE`

**Sintomas:** Diminuir `gemini_AUTOCOMPACT_PCT_OVERRIDE` faz a compactacao acontecer mais cedo, nao mais tarde.

**O que ajuda:**

- Em algumas versoes atuais do Gemini Code, valores menores podem reduzir o limite de compactacao em vez de extende-lo.
- Se voce quer mais espaco de trabalho, remova `gemini_AUTOCOMPACT_PCT_OVERRIDE` e prefira `/compact` manual em limites logicos de tarefas.
- Use o guia `strategic-compact` do egc em vez de forcar um limite menor de auto-compactacao.

### Conectores MCP parecem conectados mas falham apos compactacao

**Sintomas:** Ferramentas MCP do Gmail ou Google Drive falham apos compactacao mesmo que o conector ainda apareca autenticado na UI.

**O que ajuda:**

- Desative e reative o conector afetado apos a compactacao.
- Se sua versao do Gemini Code suportar, adicione um hook de lembrete `PostCompact` que avisa para verificar a autenticacao do conector apos a compactacao.
- Trate isso como uma etapa de recuperacao de estado de autenticacao, nao uma correcao permanente.

### Edicoes de hook nao recarregam automaticamente

**Sintomas:** Mudancas nos hooks de `settings.json` nao entram em vigor ate a sessao ser reiniciada.

**O que ajuda:**

- Reinicie a sessao do Gemini Code apos alterar hooks.
- Usuarios avancados as vezes criam um comando local `/reload` em torno de `kill -HUP $PPID`, mas o egc nao o inclui porque e dependente de shell e nao universalmente confiavel.

### Respostas `529 Overloaded` repetidas

**Sintomas:** O Gemini Code comeca a falhar sob alta pressao de hook/ferramenta/contexto.

**O que ajuda:**

- Reduza a pressao de definicao de ferramentas com `ENABLE_TOOL_SEARCH=auto:5` se sua configuracao suportar.
- Diminua `MAX_THINKING_TOKENS` para trabalho de rotina.
- Direcione trabalho de subagente para um modelo mais barato como `gemini_CODE_SUBAGENT_MODEL=haiku` se sua configuracao expoe esse controle.
- Desabilite servidores MCP nao utilizados por projeto.
- Compacte manualmente em pontos naturais em vez de esperar pela auto-compactacao.

## Documentacao Relacionada do egc

- [hook-bug-workarounds.md](./hook-bug-workarounds.md) para o checklist resumido de hook/compactacao/recuperacao MCP.
- [hooks/README.md](../hooks/README.md) para o ciclo de vida documentado de hooks e comportamento de codigos de saida do egc.
- [token-optimization.md](./token-optimization.md) para configuracoes de custo e gerenciamento de contexto.
- [issue #644](https://github.com/Fmarzochi/EGC-code/issues/644) para o relatorio original e ambiente testado.
