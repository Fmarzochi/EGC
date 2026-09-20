<!-- LANGUAGE-SELECTOR-START -->

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · **Español** · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [Türkçe](../tr/README.md) · [简体中文](../zh-CN/README.md)

<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/images/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

<div align="center">

# EGC - Dar a cada agente de IA el mismo cerebro

**Un motor local que proporciona a cada herramienta de codificación de IA en tu máquina la misma memoria, los mismos guardrails y el mismo contexto, en cada sesión.**

</div>

---

EGC es un tiempo de ejecución local para herramientas de codificación IA. Instálalo una vez y Cursor, Claude Code, Codex, Copilot, Aider y el resto de las 20 herramientas de codificación de IA que soporta compartir una memoria cifrada de tus proyectos, una capa de seguridad frente a cada comando, un filtro que mantiene la salida ruidosa lejos del modelo, y un bus en vivo que permite que tus sesiones abiertas se vean entre sí. Funciona nativamente con Claude, GPT-4o, Gemini, DeepSeek, Mistral, Groq, Cohere y Vertex AI, más OpenRouter para Qwen3, Lama 4, y más.

Nada sale de su máquina. La memoria vive en `~/.egc`, cifrada con AES-256-GCM, mantenida por proyecto y sucursal, y nunca comprometida con git.

---

## Instalar

```bash
npm install -g @egchq/egc && egc install
```

Ese es todo el motor. `egc install` detecta las herramientas que tienes, registra los dos servidores MCP locales en cada uno de ellos, escribe el protocolo de memoria que cada agente lee y configura el Triturador de Token. Hace una pregunta, si también desea la biblioteca de prompt opcional, y el valor por defecto es no.

<div align="center">
  <img src="../../assets/gifs/install.gif" alt="One command installs EGC across 20 AI coding tools" width="800" />
</div>

[Guía completa de instalación](../../docs/installation.md)

---

## El motor: Cómo funciona EGC

EGC es un cerebro con cuatro facultades. Cada una está encendida desde la primera instalación, en todas las herramientas soportadas, sin ningún comando que aprender.

<div align="center">
  <img src="../../assets/gifs/sharedbrain.gif" alt="A decision made in Cursor is already known in Claude Code" width="900" />
</div>

### Memoria: Lo que un agente aprende cada agente conoce

Decisiones, contexto de sesión, memoria de trabajo y lecciones aprendidas se capturan a medida que trabaja y están disponibles en cualquier otro terminal, IDE o agente que abra. Usted habla, naturalmente, en cualquier idioma: "guardar esta sesión", "¿qué decidimos sobre la autenticidad?", "recuerde esta decisión". EGC comprende la intención y almacena o recuerda el contexto. No hay ningún comando para memorizar.

### Session Mesh: Tus sesiones abiertas se ven entre sí

Dos pestañas Cursor, un terminal Claude Code y una sesión Antigravity comparten un autobús en vivo. Anuncian en qué están trabajando, reclaman los archivos que editan, trabajar unos a otros y recoger los eventos en el momento de su aterrizaje, por lo que las sesiones paralelas cooperan en lugar de chocar.

### Guardiana: una capa de seguridad frente a cada comando

Guardian valida los comandos antes de que funcionen, compuertas arriesgadas escribe y evita que el contexto se desborde, en segundo plano, sin invocar nada. La cobertura depende del soporte de cada gancho de cada herramienta; la [Evaluación de seguridad](../../docs/security/SECURITY-ASSESSMENT.md#known-limitations) documenta la excepción.

### Triturador de Tok: El ruido nunca alcanza el modelo

Antes de que la salida del shell alcance el modelo, el triturador de Token comprime los registros de git, prueba el spam, instalar ruido y JSON gigante en hasta un 90 por ciento mientras se mantienen todos los errores y advertencias. Pregunte "¿cuánto he guardado?" en cualquier idioma y la respuesta viene directamente de su contador local.

---

## Inicio rápido

No hay dos pasos. Abre cualquiera de tus herramientas de IA y habla: "hola", "continuemos", "recuerda esta decisión", en cualquier idioma. Las sesiones se conectan, cargan memoria, y cada pestaña abierta ya sabe lo que están haciendo los demás.

Un tablero con actividad de agente, tokens y costos comienza justo después de la instalación. ¿Preferir control explícito? Cada comando está documentado en la [guía de instalación](../../docs/installation.md): probablemente nunca necesitarás escribir uno.

---

## Biblioteca de Prompt (opcional)

Separado del motor, y apagado de forma predeterminada, EGC también envía una biblioteca escrita de sesiones de ingeniería real: usted tiene acceso a 61 agentes, 232 habilidades, y 77 comandos, más 109 reglas. Especialistas que revisan tu código por su cuenta, las mejores guías de práctica para cada idioma y situación, atajos que ejecutan toda una secuencia de tareas, y reglas de estilo que mantienen su código consistente. Agregue a cada herramienta detectada con `egc install --prompt-library`, o a una herramienta con `egc install --target <tool> --profile full`. Sáltese y el motor funcione exactamente lo mismo.

---

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · **Español** · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [Türkçe](../tr/README.md) · [简体中文](../zh-CN/README.md)

---

## Soporte EGC

EGC es construido por un desarrollador, mantenido en abierto, y libre. El motor es Apache-2. y permanece gratis: si alguna vez el EGC ofrece algo pagado, será una capa de equipo encima de ella, nunca la memoria de su máquina.

- **[Website](https://fmarzochi.github.io/EGCSite)**: documentos completos, resumen de características y demo en vivo
- **[Vision](../../docs/VISION.md)**: adónde va EGC y qué permanece libre
- **[Únete al Discord](https://discord.gg/TxppsGb52)**: haz preguntas, comparte comentarios
- **[Patrocinador en GitHub](https://github.com/sponsors/Fmarzochi)**: cualquier cantidad
- **[Donar a través de PayPal](https://www.paypal.com/donate/?business=fmarzochi%40gmail.com&currency_code=USD)**: no se necesita una cuenta de GitHub
- **Destaca el repositorio**: ayuda a otros desarrolladores a encontrarlo
- **[Contribute](../../.github/CONTRIBUTING.md)**: agentes, habilidades, comandos, correcciones de errores, documentos
- **Compartir**: si el EGC cambió cómo trabajas, cuéntale a alguien

### Patrocinadores

El apoyo de la comunidad mantiene vivo e independiente este proyecto.

#### Socios de herramienta

Herramientas de codificación de IA que se integran nativamente con EGC. Los socios obtienen la colocación del logotipo a través de todos los README y EGCSite.

<a href="https://www.pincushion.io/"><img src="https://www.pincushion.io/logo-icon.png" width="52" height="52" alt="Pincushion" title="Pincushion" /></a>

#### Patrocinadores Anuales · _Sé el primer patrocinador anual._

---

#### Respaldos

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a>

#### Patrocinadores mensuales · _ser el primero_

---

<div align="center">

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp; <a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
