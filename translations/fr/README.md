<!-- LANGUAGE-SELECTOR-START -->

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · **Français** · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [Türkçe](../tr/README.md) · [简体中文](../zh-CN/README.md)

<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/images/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

<div align="center">

# EGC - Donnez le même cerveau à chaque agent IA

**Un moteur local qui donne à chaque outil de codage AI sur votre machine la même mémoire, les mêmes rails de garde et le même contexte, à chaque session.**

</div>

---

EGC est un premier runtime local pour les outils de codage IA. Installez-le une fois et Curseur, Claude Code, Codex, Copilot, Aider et le reste des 20 outils de codage IA qu'il supporte partager une mémoire chiffrée de vos projets, une couche de sécurité devant chaque commande, un filtre qui éloigne la sortie bruyante du modèle, et un bus en direct qui permet à vos sessions ouvertes de se voir. Fonctionne nativement avec Claude, GPT-4o, Gemini, DeepSeek, Mistral, Groq, Cohere et Vertex AI, plus OpenRouter pour Qwen3, Llama 4, et plus.

Rien ne quitte votre machine. La mémoire réside dans `~/.egc`, chiffrée avec AES-256-GCM, gardée par projet et branche, et jamais engagée à git.

---

## Installer

```bash
npm install -g @egchq/egc && egc install
```

C'est tout le moteur. `egc install` détecte les outils que vous avez, enregistre les deux serveurs MCP locaux dans chacun d'eux, écrit le protocole mémoire que chaque agent lit et met en place le Token Crusher. Il pose une question, si vous voulez aussi la bibliothèque d'invite optionnelle, et la valeur par défaut est non.

<div align="center">
  <img src="../../assets/gifs/install.gif" alt="One command installs EGC across 20 AI coding tools" width="800" />
</div>

[Guide d'installation complète](../../docs/installation.md)

---

## Le Moteur : Comment fonctionne l'EGC

L'EGC est un cerveau avec quatre facultés. Chacune d'entre elles se trouve à partir de la première installation, dans chaque outil supporté, sans aucune commande à apprendre.

<div align="center">
  <img src="../../assets/gifs/sharedbrain.gif" alt="A decision made in Cursor is already known in Claude Code" width="900" />
</div>

### Mémoire : Ce qu'un agent apprend, chaque agent sait

Les décisions, le contexte de session, la mémoire de travail et les leçons apprises sont saisies au fur et à mesure que vous travaillez et sont disponibles dans tout autre terminal, IDE ou agent que vous ouvrez. Vous parlez naturellement, dans n'importe quelle langue: "sauver cette session", "qu'est-ce que nous avons décidé de l'identifier?", "se souvenir de cette décision". Le FEM comprend l'intention et stocke ou rappelle le contexte. Il n'y a aucune commande à mémoriser.

### Mesure de session : Vos sessions ouvertes Voir les autres

Deux onglets Cursor, un terminal Claude Code et une session d'antigravité partagent un bus en direct. Ils annoncent sur quoi ils travaillent, réclament les fichiers qu'ils modifient, travaillent à la main les uns aux autres et ramassent les événements le moment où ils atterrissent, de sorte que les sessions parallèles coopèrent au lieu de collision.

### Gardien : Une couche de sécurité devant chaque commande

Guardian valide les commandes avant qu'elles ne s'exécutent, porte des écritures risquées et empêche le contexte de se déverser, en arrière-plan, sans que vous n'invoquiez quoi que ce soit. La couverture dépend du soutien de chaque outil; [Évaluation de la sécurité](../../docs/security/SECURITY-ASSESSMENT.md#known-limitations) documente l'exception.

### Ecraseur de jetons : Le bruit ne parvient jamais à atteindre le modèle

Avant que la sortie du shell n'atteigne le modèle, le Crusher compresse les logs git, teste le spam, installer du bruit et du JSON géant jusqu'à 90 % tout en gardant toutes les erreurs et avertissements. Demander "combien ai-je économisé?" dans n'importe quelle langue, et la réponse vient directement de votre livre local.

---

## Démarrage rapide

Il n'y a pas de deuxième étape. Ouvrez n'importe lequel de vos outils IA et parlez simplement: "Bonjour", "Continuon", "souvenons-nous de cette décision", dans n'importe quelle langue. Les sessions se connectent, les charges de la mémoire, et chaque onglet ouvert sait déjà ce que les autres font.

Un tableau de bord en direct avec activité de l'agent, les jetons et les coûts commencent immédiatement après l'installation. Préférer un contrôle explicite ? Chaque commande est documentée dans le [guide d'installation](../../docs/installation.md) : vous n'aurez probablement jamais besoin de taper un.

---

## Bibliothèque d'invitation (facultatif)

Séparé du moteur, et non du moteur, EGC expédie également une bibliothèque écrite à partir de véritables sessions d'ingénierie: vous avez accès à 61 agents, 232 compétences, et 77 commandes, plus 109 règles. Des spécialistes qui révisent votre code par eux-mêmes, des guides des meilleures pratiques pour chaque langue et situation, qui exécutent toute une séquence de tâches, et des règles de style qui gardent votre code cohérent. Ajoutez-le à chaque outil détecté avec `egc install --prompt-library`, ou à un outil avec `egc install --target <tool> --profile full`. Sautez et le moteur fonctionne exactement de la même façon.

---

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · **Français** · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [Türkçe](../tr/README.md) · [简体中文](../zh-CN/README.md)

---

## Soutenir EGC

L'EGC est construit par un développeur, maintenu en ouvert, et gratuit. Le moteur est Apache-2. et reste gratuit : si EGC offre quelque chose de payé, ce sera une couche d'équipe, jamais la mémoire de votre machine.

- **[Website](https://fmarzochi.github.io/EGCSite)**: documentation complète, aperçu des fonctionnalités, et démo en direct
- **[Vision](../../docs/VISION.md)**: où va EGC, et ce qui reste gratuit
- **[Rejoignez Discord](https://discord.gg/TxppsGb52)**: posez des questions, partagez vos commentaires
- **[Sponsor sur GitHub](https://github.com/sponsors/Fmarzochi)**: n'importe quel montant
- **[Faire un don via PayPal](https://www.paypal.com/donate/?business=fmarzochi%40gmail.com&currency_code=USD)**: aucun compte GitHub n'est nécessaire
- **Mettre en vedette le dépôt** : aide les autres développeurs à le trouver
- **[Contribute](../../.github/CONTRIBUTING.md)** : agents, compétences, commandes, corrections de bugs, docs
- **Partager** : si EGC a changé votre façon de travailler, dites-le à quelqu'un

### Sponsors

Le soutien de la communauté maintient ce projet vivant et indépendant.

#### Partenaires de l'outil

Outils de codage AI qui s'intègrent nativement à l'EGC. Les partenaires obtiennent un placement de logo dans tous les READMES et EGCSite.

<a href="https://www.pincushion.io/"><img src="https://www.pincushion.io/logo-icon.png" width="52" height="52" alt="Pincushion" title="Pincushion" /></a>

#### Sponsors annuels · _Soyez le premier sponsor annuel._

---

#### Carrières

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a>

#### Parrains mensuels · _être le premier_

---

<div align="center">

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp; <a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
