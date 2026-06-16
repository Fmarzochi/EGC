# Solucao de Problemas

## `EACCES: permission denied` no macOS

**Sintoma:** `npm install -g @egchq/egc` falha com:

```
npm error code EACCES
npm error syscall mkdir
npm error path /usr/local/lib/node_modules/@egchq
npm error errno -13
```

**Causa:** O Node.js foi instalado em todo o sistema (via instalador oficial ou Homebrew) e o npm nao consegue escrever em `/usr/local/lib/node_modules` sem acesso root.

**Solucao:** Use um gerenciador de versoes do Node para que o Node fique no seu diretorio home e instalacoes globais funcionem sem `sudo`.

Com [nvm](https://github.com/nvm-sh/nvm):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# reinicie o terminal e entao:
nvm install --lts
nvm use --lts
npm install -g @egchq/egc
```

Com [fnm](https://github.com/Schniz/fnm) (mais rapido):

```bash
brew install fnm
# Adicione ao ~/.zshrc ou ~/.bash_profile e reinicie o terminal:
eval "$(fnm env --use-on-cd)"
fnm install --lts
fnm use lts-latest
npm install -g @egchq/egc
```

Se preferir nao alterar sua instalacao do Node, a alternativa e [configurar um prefixo global personalizado do npm](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally) no seu diretorio home.
