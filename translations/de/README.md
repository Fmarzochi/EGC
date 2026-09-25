<!-- LANGUAGE-SELECTOR-START -->

🌐 [English](../../README.md) · [العربية](../ar/README.md) · **Deutsch** · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [Türkçe](../tr/README.md) · [简体中文](../zh-CN/README.md)

<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/images/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

<div align="center">

# EGC - Gib jedem KI-Agent das gleiche Gehirn

**Ein lokaler Motor, der jedem KI-Codierwerkzeug auf deiner Maschine in jeder Sitzung den gleichen Arbeitsspeicher, denselben Wächtern und den gleichen Kontext verleiht.**

</div>

---

EGC ist eine lokale Laufzeit für AI-Codierungswerkzeuge. Installiere es einmal und Cursor, Claude Code, Codex, Copilot, Aider und der Rest der 20 AI-Codierungstools teilen einen verschlüsselten Speicher Ihrer Projekte eine Sicherheitsschicht vor jedem Befehl, ein Filter, der die Geräuschausgabe vom Modell fernhält und ein Live-Bus, mit dem sich Ihre offenen Sitzungen sehen lassen. Funktioniert nativ mit Claude, GPT-4o, Gemini, DeepSeek, Mistral, Groq, Cohere, Vertex AI, plus OpenRouter für Qwen3, Llama 4 und mehr.

Nichts verlässt deine Maschine. Speicher lebt in `~/.egc`, verschlüsselt mit AES-256-GCM, wird pro Projekt und Zweig gehalten und nie zu git verpflichtet.

---

## Installieren

```bash
npm install -g @egchq/egc && egc install
```

Das ist der ganze Motor. `egc install` erkennt die Werkzeuge, die du hast, registriert die beiden lokalen MCP-Server in jedem von ihnen schreibt das Memory-Protokoll, das jeder Agent liest und setzt den Token Crusher ein. Es stellt eine Frage, ob Sie auch die optionale Eingabeaufforder-Bibliothek wollen, und die Standardeinstellung ist nein.

<div align="center">
  <img src="../../assets/gifs/install.gif" alt="One command installs EGC across 20 AI coding tools" width="800" />
</div>

[Vollständige Installationsanleitung](../../docs/installation.md)

---

## Der Motor: Wie EGC funktioniert

EGC ist ein Gehirn mit vier Fakultäten. Jeder ist von der ersten Installation an, in jedem unterstützten Werkzeug, ohne dass ein Befehl zu erlernen ist.

<div align="center">
  <img src="../../assets/gifs/sharedbrain.gif" alt="A decision made in Cursor is already known in Claude Code" width="900" />
</div>

### Speicher: Was ein Agent lernt, jeder Agent kennt

Entscheidungen, Sitzungskontexte, Arbeitsspeicher und gelernte Lektionen werden während Ihrer Arbeit erfasst und stehen in jedem anderen Terminal, IDE oder Agenten zur Verfügung, den Sie öffnen. Sie sprechen natürlich in jeder Sprache: "Speichern Sie diese Sitzung", "Was haben wir beschlossen über auth?", "erinnern Sie sich an diese Entscheidung". EGC versteht die Absicht und speichert oder erinnert den Kontext. Es gibt keinen Befehl zum Speichern.

### Sitzungsnetz: Ihre offenen Sitzungen sehen jede andere

Zwei Cursor-Registerkarten, ein Claude Code Terminal und eine Antigravity Session teilen sich einen Live-Bus. Sie verkünden, woran sie arbeiten, beanspruchen die Dateien, die sie bearbeiten, Hand arbeiten sich gegenseitig und holen die Veranstaltungen in dem Moment ab, in dem sie landen, so dass parallele Sitzungen zusammenarbeiten statt zu kollidieren.

### Wächter: Eine Sicherheitsebene vor jedem Kommando

Wächter prüft Befehle, bevor sie ausgeführt werden, aktiviert riskante Schreibvorgänge und schützt den Kontext vor Überlaufen im Hintergrund, ohne dass Sie irgendetwas aufrufen. Die Abdeckung hängt von der eigenen Hakenunterstützung jedes Tools ab; die [Sicherheitsprüfung](../../docs/security/SECURITY-ASSESSMENT.md#known-limitations) dokumentiert die Ausnahme.

### Token Crusher: Rauschen erreicht nie das Modell

Bevor die Shell-Ausgabe das Modell erreicht, komprimiert der Token Crusher Git-Logs, Test-Spam, installieren Sie Rauschen und gigantische JSON um bis zu 90 Prozent, während jeder Fehler und jede Warnung beachtet wird. Fragen Sie nach "Wie viel habe ich gespart?" in jeder Sprache und die Antwort kommt direkt von Ihrem lokalen Ledger.

---

## Schnellstart

Es gibt keinen zweiten Schritt. Öffnen Sie eines Ihrer KI-Tools und sprechen Sie einfach: "hi", "Let's continue", "remember this decision ", in jeder Sprache. Sessions verbinden sich, Speicher lädt und jeder geöffnete Tab weiß bereits, was die anderen tun.

Ein Live-Dashboard mit Agentenaktivität, Token und Kosten beginnt unmittelbar nach der Installation. explizite Kontrolle bevorzugen? Jeder Befehl ist in der [Installationsanleitung] dokumentiert (docs/installation.md): Sie werden wahrscheinlich nie eines eingeben müssen.

---

## Prompt-Bibliothek (optional)

Getrennt vom Motor und standardmäßig ausgeschaltet, liefert EGC auch eine Bibliothek, die von realen Engineering-Sitzungen geschrieben wurde: Sie erhalten Zugriff auf 61 Agenten, 232 Fähigkeiten und 77 Befehle plus 109 Regeln. Spezialisten, die Ihren Code einzeln überprüfen, Best Practice-Führer für jede Sprache und jede Situation Verknüpfungen, die eine ganze Reihe von Aufgaben ausführen, und Stilregeln, die Ihren Code konsistent halten. Fügen Sie es zu jedem erkannten Werkzeug mit `egc install --prompt-library` oder einem Werkzeug mit `egc install --target <tool> --profile full` hinzu. Überspringen und der Motor funktioniert genau dasselbe.

---

🌐 [English](../../README.md) · [العربية](../ar/README.md) · **Deutsch** · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [Türkçe](../tr/README.md) · [简体中文](../zh-CN/README.md)

---

## EGC unterstützen

EGC wird von einem Entwickler gebaut, der offen und kostenlos gewartet wird. Der Motor ist Apache-2. und bleibt kostenlos: wenn EGC jemals etwas bezahlt, es wird eine Team-Ebene auf ihm, nie den Speicher auf Ihrem Computer.

- **[Website](https://fmarzochi.github.io/EGCSite)**: Vollständige Dokumentation, Funktionsübersicht und Live-Demo
- **[Vision](../../docs/VISION.md)**: wohin das EGC geht und was frei bleibt
- **[Join the Discord](https://discord.gg/TxppsGb52)**: stelle Fragen, teile Feedback
- **[Sponsor auf GitHub](https://github.com/sponsors/Fmarzochi)**: beliebiger Betrag
- **[Spenden via PayPal](https://www.paypal.com/donate/?business=fmarzochi%40gmail.com&currency_code=USD)**: Kein GitHub Konto benötigt
- **Starte das Repository**: Hilf anderen Entwicklern diese zu finden
- **[Contribute](../../.github/CONTRIBUTING.md)**: Agenten, Fähigkeiten, Befehle, Bugfixes, Dokumentation
- **Teilen**: wenn EGC deine Arbeitsweise geändert hat, sag jemandem

### Sponsoren

Die Unterstützung durch die Community hält dieses Projekt lebendig und unabhängig.

#### Werkzeugpartner

AI Coding Tools, die sich nativ in EGC integrieren. Partner erhalten Logoplatzierung über alle READMEs und EGCSite.

<a href="https://www.pincushion.io/"><img src="https://www.pincushion.io/logo-icon.png" width="52" height="52" alt="Pincushion" title="Pincushion" /></a>

#### Jährliche Sponsoren · _Seien Sie der erste jährliche Sponsor._

---

#### Backers

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a>

#### Monatliche Sponsoren · _be der Erste_

---

<div align="center">

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp; <a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
