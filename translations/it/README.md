<!-- LANGUAGE-SELECTOR-START -->

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · **Italiano** · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [Türkçe](../tr/README.md) · [简体中文](../zh-CN/README.md)

<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/images/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

<div align="center">

# EGC - Dare ad ogni agente AI lo stesso cervello

**Un motore locale che fornisce ad ogni strumento di codifica AI sulla tua macchina la stessa memoria, gli stessi parapetti e lo stesso contesto, in ogni sessione.**

</div>

---

EGC è una runtime locale prima per gli strumenti di codifica AI. Installare una volta e cursore, Codice Claude, Codex, Copilot, Aider e il resto dei 20 strumenti di codifica AI che supporta condividere una memoria crittografata dei vostri progetti, uno strato di sicurezza davanti ad ogni comando, un filtro che mantiene l'uscita rumorosa lontano dal modello, e un bus live che permette alle sessioni aperte di vedersi a vicenda. Funziona nativamente con Claude, GPT-4o, Gemini, DeepSeek, Mistral, Groq, Cohere e Vertex AI, più OpenRouter per Qwen3, Llama 4 e altro ancora.

Niente lascia la tua macchina. La memoria vive in `~/.egc`, crittografato con AES-256-GCM, mantenuto per progetto e ramo, e mai impegnato a git.

---

## Installa

```bash
npm install -g @egchq/egc && egc install
```

Questo è tutto il motore. `egc install` rileva gli strumenti che hai, registra i due server MCP locali in ciascuno di essi, scrive il protocollo di memoria ogni agente legge, e imposta il Token Crusher. Fa una domanda, se vuoi anche la libreria di prompt opzionale, e il valore predefinito è no.

<div align="center">
  <img src="../../assets/gifs/install.gif" alt="One command installs EGC across 20 AI coding tools" width="800" />
</div>

[Guida completa all'installazione](../../docs/installation.md)

---

## Il Motore: Come Funziona L'EGC

EGC è un cervello con quattro facoltà. Ognuno è acceso dalla prima installazione, in ogni strumento supportato, senza alcun comando da imparare.

<div align="center">
  <img src="../../assets/gifs/sharedbrain.gif" alt="A decision made in Cursor is already known in Claude Code" width="900" />
</div>

### Memoria: Quello Che Un Agente Apprende, Ogni Agente Conosce

Decisioni, contesto della sessione, memoria di lavoro e lezioni apprese vengono catturati mentre si lavora e sono disponibili in qualsiasi altro terminale, IDE o agente che si apre. Lei parla naturalmente, in qualsiasi lingua: "salva questa sessione", "che cosa abbiamo deciso di auth?", "ricorda questa decisione". Il GECC comprende l'intento e memorizza o ricorda il contesto. Non c'è alcun comando da memorizzare.

### Sessione Mesh: Le Sessioni Aperte Vedi Ogni Altro

Due schede Cursore, un terminale Codice Claude e una sessione Antigravity condividono un bus dal vivo. Essi annunciano che cosa stanno lavorando su, rivendicare i file che hanno modificato, lavorare a mano gli uni agli altri e raccogliere gli eventi nel momento in cui atterrano, così le sessioni parallele cooperano invece di collidere.

### Guardian: uno strato di sicurezza davanti ad ogni comando

Guardian convalida i comandi prima di eseguire, cancelli rischiosi scrive e mantiene il contesto da traboccare, in background, senza che si invochi nulla. La copertura dipende dal supporto del gancio di ogni strumento; la [valutazione della sicurezza](../../docs/security/SECURITY-ASSESSMENT.md#known-limitations) documenta l'eccezione.

### Token Crusher: Il rumore non raggiunge mai il modello

Prima che l'uscita della shell raggiunga il modello, il Token Crusher comprime git log, test spam, installare rumore e gigante JSON fino al 90% mantenendo ogni errore e avvertimento. Chiedi "quanto ho salvato?" in qualsiasi lingua e la risposta viene direttamente dal tuo registro locale.

---

## Avvio Rapido

Non c'è nessun passo due. Apri uno qualsiasi dei tuoi strumenti AI e chiacchiera: "ciao", "continuiamo", "ricordi questa decisione", in qualsiasi lingua. Le sessioni si collegano, i carichi di memoria, e ogni scheda aperta sa già cosa stanno facendo gli altri.

Un cruscotto dal vivo con attività dell'agente, token e costi inizia subito dopo l'installazione. Preferire un controllo esplicito? Ogni comando è documentato nella [guida all'installazione](../../docs/installation.md): probabilmente non avrai mai bisogno di digitarne uno.

---

## Chiedi La Libreria (Opzionale)

Separato dal motore, e spento per impostazione predefinita, EGC fornisce anche una biblioteca scritta da sessioni di ingegneria reale: si ottiene l'accesso a 61 agenti, 232 abilità, e 77 comandi, più 109 regole. Specialisti che revisionano il tuo codice da soli, guide best practice per ogni lingua e situazione, scorciatoie che eseguono un'intera sequenza di attività e regole di stile che mantengono il codice coerente. Aggiungilo ad ogni strumento rilevato con `egc install --prompt-library`, o a uno strumento con `egc install --target <tool> --profile full`. Salta e il motore funziona esattamente lo stesso.

---

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · **Italiano** · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [Türkçe](../tr/README.md) · [简体中文](../zh-CN/README.md)

---

## EGC Di Sostegno

EGC è costruito da un unico sviluppatore, mantenuto all'aperto e libero. Il motore è Apache-2. e rimane gratis: se EGC offre qualcosa di pagato, sarà uno strato di squadra sopra di esso, mai la memoria sulla vostra macchina.

- **[Website](https://fmarzochi.github.io/EGCSite)**: documenti completi, panoramica delle funzionalità e demo live
- **[Vision](../../docs/VISION.md)**: dove sta andando EGC e cosa rimane gratis
- **[Unisciti a Discord](https://discord.gg/TxppsGb52)**: fai domande, condividi il feedback
- **[Sponsor su GitHub](https://github.com/sponsors/Fmarzochi)**: qualsiasi importo
- **[Dona tramite PayPal](https://www.paypal.com/donate/?business=fmarzochi%40gmail.com&currency_code=USD)**: nessun account GitHub necessario
- **Star il repository**: aiuta gli altri sviluppatori a trovarlo
- **[Contribute](../../.github/CONTRIBUTING.md)**: agenti, abilità, comandi, correzioni di bug, documenti
- **Condividi**: se EGC cambia come lavori, dica a qualcuno

### Sponsor

Il sostegno della comunità mantiene questo progetto vivo e indipendente.

#### Partner Strumenti

Strumenti di codifica AI che si integrano nativamente con EGC. I partner ottengono il posizionamento del logo su tutti i README ed EGCSite.

<a href="https://www.pincushion.io/"><img src="https://www.pincushion.io/logo-icon.png" width="52" height="52" alt="Pincushion" title="Pincushion" /></a>

#### Sponsor annuali · _Sii il primo sponsor._

---

#### Sostenitori

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a>

#### Sponsor mensili · _essere il primo_

---

<div align="center">

[![OpenSSF Migliori Pratiche](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp; <a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
