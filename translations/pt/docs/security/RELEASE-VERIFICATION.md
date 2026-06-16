# Verificacao de Release

Cada release do EGC e publicado com atestados de proveniencia de build que permitem verificar a integridade e autenticidade dos ativos do release.

## Verificando a Proveniencia do Pacote npm

O EGC e publicado no npm com `--provenance`, o que gera um atestado de proveniencia assinado vinculado ao workflow do GitHub Actions que o construiu.

Para verificar:

```bash
npm audit signatures egc-universal
```

Saida esperada:

```
audited 1 package in Xs
1 package has a verified registry signature
1 package has a verified attestation
```

## Verificando os Ativos do GitHub Release

A proveniencia de build para tarballs de release e atestada via [GitHub Artifact Attestations](https://docs.github.com/en/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds).

Para verificar um tarball de release:

```bash
gh attestation verify egc-universal-<version>.tgz \
  --owner Fmarzochi \
  --repo EGC
```

A saida esperada confirma que o artefato foi produzido pelo workflow `release.yml` no repositorio `Fmarzochi/EGC`.

## O Que e Atestado

| Ativo | Tipo de Atestado |
|-------|-----------------|
| tarball npm (`egc-universal-*.tgz`) | Proveniencia de build (SLSA Nivel 2) |
| pacote npm (publicado) | proveniencia npm (flag `--provenance`) |

## Verificacao Criptografica

Todos os atestados usam a infraestrutura de assinatura sem chave do Sigstore. Nenhum gerenciamento manual de chaves e necessario. A verificacao usa o log de transparencia publico do Sigstore (Rekor) para confirmar que a assinatura foi criada durante a execucao do CI no momento do release.
