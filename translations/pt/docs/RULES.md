# Regras de Governanca do EGC

Estas regras governam as contribuicoes ao **Extended Global Context (EGC)**: um runtime MCP local com memoria persistente, contexto compartilhado e integracao plug-and-play para ferramentas de IA para codificacao.

> **EGC - Extended Global Context**
> **Desenvolvido por Felipe Marzochi**
> **@MarzochiFelipe**
> **https://github.com/Fmarzochi/EGC**
> **© Todos os direitos reservados**

---

## 1. Estabilidade em Primeiro Lugar

- **Estabilidade acima de Expansao:** Fortalecer o que existe antes de adicionar novas areas.
- **Previsibilidade:** Evitar desvios arquiteturais e adicoes de frameworks sem validacao.
- **Superficie Minima:** Nao introduzir dependencias frageis ou complexidade desnecessaria. Manter o ecossistema enxuto.

## 2. Integridade do Runtime

- **Servidores MCP sao o nucleo:** Mudancas em `mcp/servers/egc-guardian/` ou `mcp/servers/egc-memory/` exigem padroes de validacao mais rigorosos: ambos os servidores devem compilar e passar nos testes antes do merge.
- **Schema de estado:** Nao quebrar o formato do arquivo de estado do egc-memory (`~/.egc/state/<slug>.md`). Arquivos de estado existentes devem permanecer lesiveis apos qualquer mudanca.
- **Sem Falhas Silenciosas:** Nunca engolir excecoes silenciosamente. Sempre preservar a observabilidade de erros para que falhas sejam rastreaveis.

## 3. Aplicacao Multiplataforma

- O EGC deve funcionar em **Linux**, **Windows** e **macOS**.
- **Sem Suposicoes de SO:** Nunca codificar caminhos absolutos do sistema. Usar resolucao dinamica de caminhos.
- **Compatibilidade de Shell:** Scripts e hooks nao devem depender de recursos de shell exclusivos de um SO. A matriz de CI cobre todas as tres plataformas: todos os jobs devem passar.

## 4. Formato do Ecossistema Cognitivo

### Agentes

- Agentes ficam em `agents/*.md` e definem a persona e o comportamento da IA.
- O frontmatter deve incluir `name`, `description`, `tools` e `model`.
- As descricoes devem ser especificas o suficiente para informar o roteamento de ferramentas.

### Skills

- Skills ficam em `skills/<name>/SKILL.md` e funcionam como runbooks de fluxo de trabalho.
- O frontmatter deve incluir `name`, `description` e `origin` (`EGC` ou `community`).
- Os corpos das skills devem incluir uma secao clara "Quando Ativar".

### Hooks

- Hooks interceptam eventos de ciclo de vida (ex.: `PreToolUse`, `SessionStart`) e ficam em `hooks/hooks.json`.
- Os matchers devem ser especificos. Catch-alls amplos sao proibidos.
- Use `exit 1` estritamente para bloquear comportamentos destrutivos; use `exit 0` caso contrario.
- Todos os logs de hook devem se identificar (ex.: `[EGC Hook]`).

## 5. Qualidade de Codigo e Padroes de Commit

- **Atualizacoes Imutaveis:** Prefira atualizacoes imutaveis a mutacoes de estado compartilhado.
- **Testar Antes de Mergear:** Execute `npm test` e verifique se todos os 2156 testes passam antes de enviar mudancas.
- **Seguranca:** Nunca incluir chaves de API, tokens ou segredos no historico de saida ou commit.
- **Commits:** Use commits convencionais (`feat(mcp):`, `fix(hooks):`, `docs(rules):`). Mantenha as mudancas modulares.
