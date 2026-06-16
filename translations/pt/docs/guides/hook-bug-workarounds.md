# Solucoes de Contorno para Bugs de Hook

Solucoes de contorno testadas pela comunidade para bugs atuais do Gemini Code que podem afetar configuracoes pesadas de hooks do egc.

Esta pagina e intencionalmente restrita: coleta as correcoes operacionais de maior sinal da superficie mais ampla de solucao de problemas sem repetir conselhos de configuracao especulativos ou sem suporte. Esses sao comportamentos do Gemini Code upstream, nao bugs do egc.

## Quando Usar Esta Pagina

Use esta pagina quando estiver depurando especificamente:

- rotulos falsos de `Hook Error` em execucoes de hook que funcionaram com sucesso
- compactacao mais cedo do que o esperado
- conectores MCP que parecem autenticados mas falham apos compactacao
- edicoes de hook que nao recarregam automaticamente
- respostas `529 Overloaded` repetidas sob alta pressao de hook/ferramenta

Para a superficie mais completa de solucao de problemas do egc, use [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

## Solucoes de Contorno de Alto Sinal

### Rotulos falsos de `Hook Error`

O que ajuda:

- Consumir stdin no inicio de hooks shell (`input=$(cat)`).
- Manter stdout silencioso para hooks simples de permitir/bloquear, a menos que seu hook exija explicitamente stdout estruturado.
- Enviar diagnosticos legiveis por humanos para stderr.
- Usar os codigos de saida corretos: `0` permite, `2` bloqueia, outros valores nao-zero sao tratados como erros.

```bash
input=$(cat)
echo "[BLOCKED] Motivo aqui" >&2
exit 2
```

### Compactacao mais cedo do que o esperado

O que ajuda:

- Remova `gemini_AUTOCOMPACT_PCT_OVERRIDE` se diminuir o valor causar compactacao mais cedo em sua versao.
- Prefira `/compact` manual em limites naturais de tarefas.
- Use o guia `strategic-compact` do egc em vez de forcar um limite menor.

### Autenticacao MCP parece ativa mas falha apos compactacao

O que ajuda:

- Desative e reative o conector afetado apos a compactacao.
- Se sua versao do Gemini Code suportar, adicione um hook leve de lembrete `PostCompact` que avisa para verificar a autenticacao do conector.
- Trate isso como um lembrete de recuperacao, nao uma correcao permanente.

### Edicoes de hook nao recarregam automaticamente

O que ajuda:

- Reinicie a sessao do Gemini Code apos alterar hooks.
- Usuarios avancados as vezes usam helpers de reload locais em shell, mas o egc nao inclui um porque essas abordagens sao dependentes de shell e plataforma.

### `529 Overloaded` repetido

O que ajuda:

- Reduza a pressao de definicao de ferramentas com `ENABLE_TOOL_SEARCH=auto:5` se sua configuracao suportar.
- Diminua `MAX_THINKING_TOKENS` para trabalho de rotina.
- Direcione trabalho de subagente para um modelo mais barato como `gemini_CODE_SUBAGENT_MODEL=haiku` se sua configuracao expoe esse controle.
- Desabilite servidores MCP nao utilizados por projeto.
- Compacte manualmente em pontos naturais em vez de esperar pela auto-compactacao.

## Documentacao Relacionada do egc

- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
- [token-optimization.md](./token-optimization.md)
- [hooks/README.md](../hooks/README.md)
- [issue #644](https://github.com/Fmarzochi/EGC-code/issues/644)
