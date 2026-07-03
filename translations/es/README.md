<!-- LANGUAGE-SELECTOR-START -->
**Idioma:** [English](../../README.md) | [العربية](../ar/README.md) | **Español** | [Português (Brasil)](../pt/README.md) | [हिन्दी](../hi/README.md) | [한국어](../ko/README.md) | [Русский](../ru/README.md) | [日本語](../ja/README.md)
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/hero.png" alt="EGC - Contexto Global Extendido" width="100%" />
</div>

[![npm version](https://img.shields.io/npm/v/@egchq/egc?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/@egchq/egc) [![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org) [![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org) [![Discord](https://img.shields.io/discord/1513941515452416130?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/AtazrtxJ) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](../../.github/CONTRIBUTING.md) [![Stars](https://img.shields.io/github/stars/Fmarzochi/EGC?style=flat)](https://github.com/Fmarzochi/EGC/stargazers) [![Forks](https://img.shields.io/github/forks/Fmarzochi/EGC?style=flat)](https://github.com/Fmarzochi/EGC/network/members) [![Issues](https://img.shields.io/github/issues/Fmarzochi/EGC)](https://github.com/Fmarzochi/EGC/issues) [![Maintained](https://img.shields.io/badge/Maintained-yes-brightgreen)](https://github.com/Fmarzochi/EGC/commits/main) [![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/Fmarzochi/EGC?label=openssf+scorecard&style=flat)](https://securityscorecards.dev/viewer/?uri=github.com/Fmarzochi/EGC) [![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=alert_status)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=security_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=reliability_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc) [![EGC MCP server](https://glama.ai/mcp/servers/Fmarzochi/EGC/badges/score.svg)](https://glama.ai/mcp/servers/Fmarzochi/EGC) [![Featured on Product Hunt](https://img.shields.io/badge/Product%20Hunt-featured-DA552F?logo=producthunt&logoColor=white)](https://www.producthunt.com/posts/egc)

<div align="center">

# EGC - Contexto Global Extendido

**Tus agentes de IA nunca vuelven a empezar desde cero.**

</div>

---

EGC es un entorno de ejecución local que proporciona memoria persistente a todas las herramientas de programación con IA que utilizas. Al final de cada sesión, la IA guarda lo que aprendió sobre tu proyecto: las decisiones que tomaste, lo que falló, tus preferencias y los siguientes pasos. Al comienzo de la siguiente sesión, vuelve a cargar ese estado. Una sola instalación funciona para Claude Code, Cursor, Gemini CLI, Windsurf y más. Compatible con Claude, GPT-4o, Gemini y modelos de OpenRouter, incluidos DeepSeek, Qwen3 y Llama 4.

---

## Así es como EGC funciona en la práctica

Abres Claude Code en un proyecto que no has tocado en dos semanas. Sin escribir nada:

```text
State loaded from egc-memory via ~/.egc/state/Projects-MyApp.md

Context and preferences acknowledged (terse responses).

Ready to pick up the next items:
• Test full install on a clean machine
• Add GEMINI.md with session memory protocol
• Publish v1.0.1 fix to npm after clean install test passes
• Add mcp_server_count to audit.js

=== EGC Stack Briefing ===
Stack: typescript, javascript
Stack agents: typescript-reviewer, javascript-reviewer
Always use: code-reviewer
Skill: coding-standards (cyclomatic complexity) - apply to all code written this session
===
```

La IA ya sabe qué estabas construyendo, qué decisiones tomaste, qué falló y exactamente dónde te detuviste. Lo sabe porque EGC guardó ese estado al final de tu última sesión y lo cargó nuevamente cuando esta comenzó. No escribiste nada. Simplemente empezaste a trabajar.

<div align="center">
  <img src="../../assets/egc-terminal.gif" alt="Demostración de EGC" width="700" />
</div>

---

## Instalación

```bash
npm install -g @egchq/egc && egc install
```

O ejecútalo sin instalarlo globalmente:

```bash
npx @egchq/egc install
```

[Guía completa de instalación](../../docs/installation.md)

---

## Lo que EGC ofrece a tu IA

EGC incluye dos servidores MCP que trabajan juntos durante cada sesión.

**`egc-memory`** - 14 herramientas para memoria persistente:

| Herramienta | Qué hace |
|---|---|
| `get_state` | Carga la memoria del proyecto al inicio de la sesión |
| `update_state` | Guarda decisiones, preferencias y próximos pasos |
| `store_decision` | Persiste una decisión individual en SQLite |
| `query_history` | Devuelve decisiones pasadas por marca de tiempo |
| `search_history` | Búsqueda de texto completo con clasificación BM25 |
| `working_memory_set` | Almacena contexto temporal con TTL |
| `working_memory_get` | Lee una clave temporal |
| `working_memory_list` | Lista todas las entradas temporales activas del proyecto actual |
| `lesson_save` | Registra conocimiento entre sesiones con degradación de confianza |
| `lesson_recall` | Recupera lecciones activas por encima de un umbral de confianza |
| `lesson_reinforce` | Aumenta la confianza en una lección cuando se repite el mismo patrón |
| `detect_patterns` | Identifica comandos repetidos y errores recurrentes a partir de eventos hook |
| `compress_observations` | Comprime observaciones sin procesar en resúmenes tipificados para reducir el uso de tokens |
| `get_project_state` | Devuelve metadatos de estado del servidor y del motor de almacenamiento |

Los archivos de estado se almacenan en `~/.egc/state/<project-slug>.md`. Un archivo por proyecto, en Markdown simple y legible para humanos.

**`egc-guardian`** - 5 herramientas para contexto y seguridad:

| Herramienta | Qué hace |
|---|---|
| `validate_command` | Verifica comandos de shell contra las reglas de seguridad del proyecto antes de ejecutarlos |
| `validate_write` | Valida rutas de escritura de archivos para prevenir escrituras inseguras |
| `reduce_context` | Comprime los archivos del payload para ahorrar tu presupuesto de tokens |
| `orchestrate_task` | Enruta prompts con contexto de agentes/skills y devuelve métricas de compresión |
| `auto_learn` | Analiza fallos de sesión y escribe lecciones accionables en todos los archivos de configuración de herramientas de IA del proyecto |

**`egc watch`** - daemon de sincronización bidireccional. Monitorea todos los archivos de configuración de herramientas gestionados por EGC en el proyecto. Cuando editas el contexto directamente en cualquier archivo de herramienta (Cursor, Gemini CLI, Copilot, etc.), el cambio se extrae del bloque EGC y se sincroniza con todas las demás herramientas y de vuelta a `~/.egc/state/` automáticamente.

```
egc watch              # monitorear proyecto actual
egc watch /ruta/proj   # monitorear proyecto específico
egc watch --quiet      # silenciar salida
```

### Aplicado por código, no por petición

La validación no depende de que la IA elija cooperar. EGC instala hooks en el harness que se ejecutan en cada llamada de herramienta: cada comando de shell y cada escritura de archivo se valida antes de ejecutarse, y los comandos destructivos, las rutas de credenciales y los force-push se bloquean incluso dentro de comandos compuestos. Cada prompt también se enruta contra el catálogo de componentes, inyectando en el contexto las skills y agents correctos. Si el validador falta, los hooks fallan abiertos: nunca quedas bloqueado fuera de tu propia herramienta.

Con una API key de proveedor (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY` u `OPENROUTER_API_KEY`), EGC también entiende la intención de la sesión semánticamente, en cualquier idioma, sin frases predefinidas: di que terminas por hoy y tu estado se guarda antes de que la IA responda; saluda a la mañana siguiente y tus próximos pasos ya están en contexto. Al final de la sesión, un minero de memoria destila las decisiones y lecciones de la sesión en el estado de tu proyecto. Sin key, estas funciones de LLM honestamente no hacen nada, y los hooks de ciclo de vida siguen garantizando el guardado del estado.

### Dashboard - panel de control en tiempo real

Ve cada llamada de herramienta, token y coste de tus agentes -- en vivo en el navegador. Arranca automáticamente tras `egc init`. [Guía completa](docs/installation.md#dashboard)

---

## Biblioteca de prompts

**479 componentes** incluidos como bonus: 63 agentes, 229 habilidades, 76 comandos y 111 reglas escritos en sesiones de ingeniería reales. Ignóralos por completo y EGC seguirá dándote memoria persistente.

---

## Apoya a EGC

EGC es desarrollado por una sola persona, mantenido de forma abierta y gratuito.

- **[Únete al Discord](https://discord.gg/AtazrtxJ)**: haz preguntas y comparte comentarios
- **[Patrocina en GitHub](https://github.com/sponsors/Fmarzochi)**: cualquier cantidad ayuda
- **[Dona mediante PayPal](https://www.paypal.com/donate/?business=fmarzochi%40gmail.com&currency_code=USD)**: no necesitas una cuenta de GitHub
- **Dale una estrella al repositorio**: ayuda a que otros desarrolladores lo descubran
- **[Contribuye](../../.github/CONTRIBUTING.md)**: agentes, habilidades, comandos, correcciones de errores y documentación
- **Comparte**: si EGC cambió tu forma de trabajar, cuéntaselo a alguien

### Patrocinadores

El apoyo de la comunidad mantiene este proyecto vivo e independiente.

#### Partners de herramientas

Herramientas de programacion con IA que se integran nativamente con EGC. Los partners reciben espacio para su logo en todos los READMEs y en EGCSite.

<a href="https://www.pincushion.io/"><img src="https://www.pincushion.io/logo-icon.png" width="52" height="52" alt="Pincushion" title="Pincushion" /></a>

#### Patrocinadores anuales · _Se el primer patrocinador anual._

---

#### Colaboradores

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a> <a href="https://github.com/ayushikaul02"><img src="https://avatars.githubusercontent.com/u/212903502?v=4" width="48" height="48" alt="@ayushikaul02" title="@ayushikaul02 -- Spanish translation" /></a>

#### Patrocinadores mensuales · _se el primero_

---

<div align="center">

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE) [![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;
<a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
