# Documentos VEX

Este diretorio contem documentos de Vulnerability Exploitability eXchange (VEX) para o EGC.

Documentos VEX comunicam o status de explorabilidade de vulnerabilidades conhecidas em dependencias que estao presentes na arvore de dependencias, mas nao sao exploraves no contexto de uso do EGC.

## Status Atual

`npm audit` nao relata vulnerabilidades conhecidas na arvore de dependencias do EGC em 2026-06-04.

Quando vulnerabilidades forem relatadas no futuro que nao afetam o EGC:
1. Um documento VEX sera criado no formato OpenVEX (`*.openvex.json`)
2. O documento incluira o identificador CVE, o pacote afetado e a justificativa de nao explorabilidade
3. O documento sera atualizado quando a vulnerabilidade upstream for resolvida ou quando a avaliacao mudar

## Formato

Os documentos VEX seguem a [especificacao OpenVEX](https://github.com/openvex/spec).
