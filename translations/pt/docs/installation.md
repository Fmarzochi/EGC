# Guia de Instalacao

## Via npm (recomendado)

Requer [Node.js 20 ou superior](https://nodejs.org/en/download).

```bash
npm install -g @egchq/egc
egc install
```

So isso. O instalador detecta quais ferramentas de IA voce tem instaladas e configura todas automaticamente.

---

## Linux / macOS (pelo codigo-fonte)

Nao sabe se tem o Node.js 20? Execute `node --version`. Se mostrar 20 ou superior, voce esta pronto.

```bash
git clone https://github.com/Fmarzochi/EGC.git
cd EGC
sh install.sh
```

### O que o instalador faz

1. Compila os servidores MCP (`egc-guardian`, `egc-memory`)
2. Inicializa o banco de dados SQLite local
3. Executa o bootstrap cognitivo: escreve o protocolo de memoria em `~/.claude/CLAUDE.md`, `~/.gemini/GEMINI.md` e arquivos equivalentes para cada ferramenta detectada
4. Registra ambos os servidores MCP no arquivo de configuracao de cada ferramenta detectada
5. Pergunta interativamente se deve instalar a biblioteca de prompts (63 agentes, 229 skills, 76 comandos): pulado automaticamente no CI

### Exemplo de saida

```
EGC install
  node v22.0.0
  building egc-guardian...
  building egc-memory...
  initializing database...
  bootstrapping cognitive protocol...
  ✓ ~/.claude/CLAUDE.md updated
  ✓ ~/.gemini/GEMINI.md updated
  registering MCP servers...
  ✓ registered in Antigravity CLI
  ✓ registered in Claude Code (global)
  ✓ registered in Cursor

Install prompt library? (63 agents, 229 skills, 76 commands) [y/N]:

Installation complete.
Run 'egc doctor' to verify.
```

---

## Windows

```powershell
git clone https://github.com/Fmarzochi/EGC.git
cd EGC
.\install.ps1
```

---

## Verificar a instalacao

```bash
egc doctor
```

Verifica que ambos os servidores MCP estao compilados, registrados e alcancaveis em cada ferramenta detectada.

---

## Solucao de problemas

Consulte [TROUBLESHOOTING.md](TROUBLESHOOTING.md) para problemas comuns, incluindo erros de permissao, incompatibilidades de versao do Node.js e etapas de registro manual do MCP.
