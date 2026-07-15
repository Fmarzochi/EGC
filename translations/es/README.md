<!-- LANGUAGE-SELECTOR-START -->
🌐 [English](../../README.md) · [العربية](../ar/README.md) · **Español** · [हिन्दी](../hi/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md)
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/hero.png" alt="EGC - Contexto Global Extendido" width="100%" />
</div>

[![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/Fmarzochi/EGC?label=openssf+scorecard&style=flat)](https://securityscorecards.dev/viewer/?uri=github.com/Fmarzochi/EGC) [![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=alert_status)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=security_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=reliability_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc) [![EGC MCP server](https://glama.ai/mcp/servers/Fmarzochi/EGC/badges/score.svg)](https://glama.ai/mcp/servers/Fmarzochi/EGC)

<div align="center">

# EGC - Contexto Global Extendido

**Tus agentes de IA nunca vuelven a empezar desde cero.**

*Cero configuración. Cero comandos. Tú trabajas, EGC recuerda.*

</div>

---

EGC es un entorno de ejecución local que proporciona memoria persistente a todas las herramientas de programación con IA que utilizas. Al final de cada sesión, la IA guarda lo que aprendió sobre tu proyecto: las decisiones que tomaste, lo que falló, tus preferencias y los siguientes pasos. Al comienzo de la siguiente sesión, vuelve a cargar ese estado por sí sola, sin que tengas que pedirlo. Di "sigamos" o "¿dónde quedamos?" en cualquier idioma y tu IA ya sabe qué hacer. Una sola instalación funciona para Claude Code, Cursor, Gemini CLI, Windsurf, Zed, Warp, VS Code con GitHub Copilot y más (19 herramientas en total). Compatible de forma nativa con Claude, GPT-4o, Gemini, DeepSeek, Mistral, Groq, Cohere y Vertex AI, además de OpenRouter para Qwen3, Llama 4 y más.

---

## Tu IA ya lo sabe

Abres Claude Code en un proyecto que no has tocado en dos semanas. Sin escribir nada:

```text
State loaded from egc-memory via ~/.egc/state/MyApp/main.md

Context and preferences acknowledged.

Ready to pick up:
• Fix the rate limiter edge case on concurrent requests
• Add integration tests for the new auth module
• Review open PR from @contributor before merging

=== EGC Stack Briefing ===
Stack: typescript, node
Skills: tdd-workflow, coding-standards
Agents: code-reviewer
Guardian: active, every command checked before it runs
===
```

Esto no es una caché de tu última conversación. EGC recuerda las decisiones, los callejones sin salida y tus preferencias, y vigila durante toda la sesión, bloqueando los comandos que arruinarían tu código antes de que se ejecuten. No pediste nada de esto. Simplemente empezaste a trabajar.

<div align="center">
  <img src="../../assets/egc-terminal.gif" alt="Demostración de EGC" width="700" />
</div>

---

## Instalación

Mismo comando de instalación en Windows, macOS y Linux:

```bash
npm install -g @egchq/egc && egc install
```

Windows tiene algunas particularidades propias (versión de PowerShell, Antigravity CLI, fin del plan gratuito de Gemini CLI): consulta las [notas de Windows](../../docs/installation.md#windows-notes) si algo no sale como esperas.

O ejecútalo sin instalarlo globalmente:

```bash
npx @egchq/egc install
```

**Un cerebro, muchas herramientas.** Con la extensión de GitHub Copilot Chat instalada, Copilot encuentra las skills por sí solo, y la misma memoria que ya tienes en Claude Code o Cursor aparece ahí también:

```bash
npm install -g @egchq/egc
egc install --target copilot
```

[Guía completa de instalación](../../docs/installation.md)

---

## Lo que EGC ofrece a tu IA

EGC siempre ejecuta dos cosas juntas, en cada sesión: una memoria que guarda lo importante, y una capa de seguridad que bloquea comandos peligrosos antes de que se ejecuten. Todo viene listo, sin configurar nada.

### Memoria: lo que tu IA recuerda sola

Nunca vas a memorizar un solo comando. Dilo en cualquier idioma: "sigue desde ayer", "recuerda esta decisión", "qué falló la última vez", y tu IA sabe exactamente qué hacer. El trabajo es tuyo, el recuerdo es de EGC.

**`egc-memory`**

| Herramienta | Qué hace |
|---|---|
| `get_state` | Carga todo lo que tu IA ya sabía del proyecto en el momento en que abres la sesión |
| `update_state` | Guarda lo que se decidió hoy para que mañana nadie pierda el hilo |
| `store_decision` | Anota una decisión importante, para siempre |
| `query_history` | Muestra decisiones pasadas en el orden en que ocurrieron |
| `search_history` | Encuentra cualquier cosa que se haya decidido alguna vez, aunque no recuerdes la fecha |
| `working_memory_set` / `_get` / `_list` | Notas rápidas que caducan solas cuando dejan de ser útiles |
| `lesson_save` | Registra algo aprendido, que pierde fuerza con el tiempo si nadie lo confirma de nuevo |
| `lesson_recall` | Recupera las lecciones que todavía valen la pena |
| `lesson_reinforce` | Refuerza una lección cuando se confirma de nuevo |
| `detect_patterns` | Nota cuando el mismo error o comando se repite demasiado |
| `compress_observations` | Resume el historial en bruto para que no gastes tokens en vano |
| `get_project_state` | Comprueba que la memoria funciona como debe |

Cada branch de tu proyecto guarda su propia memoria, cifrada en tu equipo: nadie más tiene acceso, ni siquiera la nube. Privacidad de fábrica, sin configurar nada.

### Contexto y seguridad: lo que vigila mientras trabajas

**`egc-guardian`**

Estas herramientas se ejecutan solas, en segundo plano. Cada comando de shell y cada escritura de archivo se comprueba antes de ejecutarse. Nunca las invocas directamente.

| Herramienta | Qué hace |
|---|---|
| `validate_command` | Comprueba cada comando antes de ejecutarlo: bloquea los que podrían causar daño |
| `validate_write` | Evita que la IA escriba en archivos sensibles por error |
| `reduce_context` | Reduce archivos grandes para que no gastes tu presupuesto de tokens en vano |
| `orchestrate_task` | Elige las herramientas correctas para cada solicitud, sin que tengas que saber cuáles existen |
| `auto_learn` | Aprende de los errores de la sesión y lo deja anotado para que no se repita |

### Aplicado por código, no por petición

Seguridad que no depende de que la IA esté de buen humor: todo comando pasa por EGC antes de ejecutarse, siempre. [Detalles completos sobre la aplicación del harness, la detección de intención de sesión y el minero de memoria →](../../docs/installation.md#enforcement)

### Una memoria. Todas tus herramientas.

Ejecuta **`egc watch`** una vez y olvídate de que existe. Cambia contexto en Cursor y aparece solo en Gemini CLI, Copilot, Windsurf, Zed: en todo lo que usas. Sin pasos manuales, sin estado desactualizado en ningún lado.

```
egc watch              # monitorear proyecto actual
egc watch /ruta/proj   # monitorear proyecto específico
egc watch --quiet      # silenciar salida
```

### Dashboard: mira a tus agentes trabajar

Mira cada llamada de herramienta, token y coste que generan tus agentes, en vivo en el navegador. Arranca automáticamente tras `egc init`. [Guía completa](../../docs/installation.md#dashboard)

---

## Biblioteca de prompts

Como bonus, EGC también te da acceso a 63 agents, 230 skills y 77 commands, más 111 rules: especialistas que revisan tu código solos, guías de buenas prácticas para cada lenguaje y situación, atajos que ejecutan toda una secuencia de tareas por ti, y reglas de estilo que mantienen tu código consistente. Todo escrito a partir de sesiones reales de ingeniería, no teoría. ¿No quieres usar nada de esto? No pasa nada: la memoria persistente de EGC funciona exactamente igual.

---

🌐 [English](../../README.md) · [العربية](../ar/README.md) · **Español** · [हिन्दी](../hi/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md)

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

Herramientas de programación con IA que se integran nativamente con EGC. Los partners reciben espacio para su logo en todos los READMEs y en EGCSite.

<a href="https://www.pincushion.io/"><img src="https://www.pincushion.io/logo-icon.png" width="52" height="52" alt="Pincushion" title="Pincushion" /></a>

#### Patrocinadores anuales · _Se el primer patrocinador anual._

---

#### Colaboradores

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a> <a href="https://github.com/ayushikaul02"><img src="https://avatars.githubusercontent.com/u/212903502?v=4" width="48" height="48" alt="@ayushikaul02" title="@ayushikaul02, Spanish translation" /></a>

#### Patrocinadores mensuales · _se el primero_

---

<div align="center">

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;
<a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
