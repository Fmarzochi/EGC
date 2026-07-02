<!-- LANGUAGE-SELECTOR-START -->
**भाषा:** [English](../../README.md) | [العربية](../ar/README.md) | [Español](../es/README.md) | [Português (Brasil)](../pt/README.md) | **हिन्दी** | [한국어](../ko/README.md)
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

[![npm version](https://img.shields.io/npm/v/@egchq/egc?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/@egchq/egc) [![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org) [![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org) [![Discord](https://img.shields.io/discord/1513941515452416130?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/AtazrtxJ) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](../../.github/CONTRIBUTING.md) [![Stars](https://img.shields.io/github/stars/Fmarzochi/EGC?style=flat)](https://github.com/Fmarzochi/EGC/stargazers) [![Forks](https://img.shields.io/github/forks/Fmarzochi/EGC?style=flat)](https://github.com/Fmarzochi/EGC/network/members) [![Issues](https://img.shields.io/github/issues/Fmarzochi/EGC)](https://github.com/Fmarzochi/EGC/issues) [![Maintained](https://img.shields.io/badge/Maintained-yes-brightgreen)](https://github.com/Fmarzochi/EGC/commits/main) [![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/Fmarzochi/EGC?label=openssf+scorecard&style=flat)](https://securityscorecards.dev/viewer/?uri=github.com/Fmarzochi/EGC) [![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=alert_status)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=security_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=reliability_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc) [![EGC MCP server](https://glama.ai/mcp/servers/Fmarzochi/EGC/badges/score.svg)](https://glama.ai/mcp/servers/Fmarzochi/EGC)

<!-- CENTERED-LANGUAGE-SELECTOR-START -->
<div align="center">

**Language / اللغة / Idioma / भाषा / 언어**

[English](../../README.md) | [العربية](../ar/README.md) | [Español](../es/README.md) | [Português (Brasil)](../pt/README.md) | **हिन्दी** | [한국어](../ko/README.md)

</div>
<!-- CENTERED-LANGUAGE-SELECTOR-END -->

<div align="center">

# EGC - Extended Global Context

**आपके AI एजेंट अब फिर कभी शून्य से शुरू नहीं होंगे।**

</div>

---

EGC एक स्थानीय रनटाइम (runtime) है जो आपके द्वारा उपयोग किए जाने वाले हर AI कोडिंग टूल को एक स्थायी मेमोरी देता है। प्रत्येक सत्र (session) के अंत में, AI आपके प्रोजेक्ट के बारे में जो कुछ भी सीखता है उसे सहेजता है: आपके द्वारा लिए गए निर्णय, क्या विफल रहा, आपकी प्राथमिकताएं, और आगे क्या करना है। अगले सत्र की शुरुआत में, यह उस स्थिति (state) को वापस लोड करता है। एक सिंगल इंस्टॉलेशन Claude Code, Cursor, Gemini CLI, Windsurf, और बहुत कुछ को कवर करता है।

---

## व्यवहार में EGC ऐसा दिखता है

आप Claude Code को एक ऐसे प्रोजेक्ट पर खोलते हैं जिसे आपने दो सप्ताह से नहीं छुआ है। बिना कुछ टाइप किए:

```
State loaded from egc-memory via ~/.egc/state/Projects--MyApp.md

Context and preferences acknowledged (terse responses).

Ready to pick up the next items:
• Test full install on a clean machine
• Add GEMINI.md with session memory protocol
• Publish v1.0.1 fix to npm after clean install test passes
• Add mcp_server_count to audit.js
```

AI को पहले से ही पता है कि आप क्या बना रहे थे, आपने क्या निर्णय लिए, क्या विफल रहा, और आप ठीक कहाँ रुके थे। वह यह इसलिए जानता है क्योंकि EGC ने आपके पिछले सत्र के अंत में उस स्थिति को सहेज लिया था और इस सत्र के शुरू होने पर उसे वापस लोड कर दिया। आपने कुछ भी टाइप नहीं किया। आपने बस काम शुरू कर दिया।

<div align="center">
  <img src="../../assets/egc-terminal.gif" alt="EGC demo" width="700" />
</div>

---

## इंस्टॉल करें

```bash
npm install -g @egchq/egc && egc install
```

या बिना वैश्विक स्तर पर इंस्टॉल किए चलाएं:

```bash
npx @egchq/egc install
```

[पूर्ण इंस्टॉलेशन गाइड](../../docs/installation.md)

---

## MCP सर्वर आपके AI को क्या देता है

EGC `egc-memory` के साथ आता है, जो एक MCP सर्वर है और 14 टूल प्रदान करता है जिन्हें आपका AI एक सत्र के दौरान कॉल कर सकता है:

| टूल | यह क्या करता है |
|---|---|
| `get_state` | सत्र की शुरुआत में प्रोजेक्ट मेमोरी लोड करता है |
| `update_state` | निर्णय, प्राथमिकताएं और अगले चरण सहेजता है |
| `store_decision` | SQLite में एक एकल निर्णय को स्थायी रूप से सहेजता है |
| `query_history` | टाइमस्टैम्प द्वारा पिछले निर्णय लौटाता है |
| `search_history` | BM25 रैंकिंग के साथ फुल-टेक्स्ट सर्च |
| `working_memory_set` | TTL के साथ अस्थायी संदर्भ (context) स्टोर करता है |
| `working_memory_get` | एक अस्थायी कुंजी (key) पढ़ता है |
| `working_memory_list` | वर्तमान प्रोजेक्ट के लिए सभी सक्रिय अस्थायी प्रविष्टियों को सूचीबद्ध करता है |
| `lesson_save` | आत्मविश्वास क्षय (confidence decay) के साथ सत्रों के बीच ज्ञान रिकॉर्ड करता है |
| `lesson_recall` | आत्मविश्वास सीमा (confidence threshold) से ऊपर सक्रिय पाठ (lessons) प्राप्त करता है |
| `lesson_reinforce` | जब वही पैटर्न दोहराया जाता है तो किसी पाठ पर आत्मविश्वास बढ़ाता है |
| `detect_patterns` | हुक इवेंट्स (hook events) से दोहराए गए कमांड और बार-बार होने वाली त्रुटियों को पहचानता है |
| `compress_observations` | टोकन उपयोग कम करने के लिए कच्चे हुक अवलोकनों (raw hook observations) को टाइप किए गए सारांशों में संकुचित करता है |
| `get_project_state` | सर्वर हेल्थ मेटाडेटा और स्टोरेज इंजन स्थिति लौटाता है |

स्टेट फाइलें `~/.egc/state/<project-slug>.md` पर रहती हैं। प्रति प्रोजेक्ट एक फाइल, प्लेन Markdown, मानव-पठनीय।

### संदर्भ और सुरक्षा - भारी कार्यों के लिए 5 टूल

**`egc-guardian`**

ये टूल पृष्ठभूमि में स्वचालित रूप से चलते हैं। हर shell कमांड और हर फाइल राइट को निष्पादन से पहले जांचा जाता है। आपको इन्हें सीधे कॉल करने की आवश्यकता नहीं है।

| टूल | यह क्या करता है |
|---|---|
| `validate_command` | निष्पादन से पहले shell कमांड को प्रोजेक्ट सुरक्षा नियमों के विरुद्ध जांचता है |
| `validate_write` | असुरक्षित राइट को रोकने के लिए फाइल राइट पथों की जांच करता है |
| `reduce_context` | टोकन बजट बचाने के लिए फाइल पेलोड को संकुचित करता है |
| `orchestrate_task` | एजेंट/स्किल संदर्भ के साथ प्रॉम्प्ट रूट करता है और संपीड़न मेट्रिक्स लौटाता है |
| `auto_learn` | सत्र की विफलताओं को खोजता है और सभी AI टूल कॉन्फिग फाइलों में कार्रवाई योग्य पाठ लिखता है |

### कोड से लागू, अनुरोध से नहीं

वैलिडेशन इस पर निर्भर नहीं करता कि AI सहयोग चुनता है या नहीं। EGC harness में hooks इंस्टॉल करता है जो हर टूल कॉल पर चलते हैं: हर shell कमांड और हर फ़ाइल लेखन निष्पादन से पहले वैलिडेट होता है, और विनाशकारी कमांड, क्रेडेंशियल पाथ और force-push कंपाउंड कमांड के भीतर भी ब्लॉक होते हैं। हर प्रॉम्प्ट को कंपोनेंट कैटलॉग के विरुद्ध रूट किया जाता है ताकि सही skills और agents संदर्भ में आ जाएँ। यदि वैलिडेटर मौजूद न हो, तो hooks खुले रूप से विफल होते हैं: आप कभी अपने ही टूल से बाहर बंद नहीं होते।

प्रोवाइडर API key (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, या `OPENROUTER_API_KEY`) के साथ EGC सत्र के इरादे को किसी भी भाषा में, बिना पूर्वनिर्धारित वाक्यांशों के, अर्थ के स्तर पर समझता है: कहिए कि आज के लिए बस, और AI के जवाब देने से पहले ही आपका स्टेट सेव हो जाता है; अगली सुबह अभिवादन कीजिए और अगले कदम पहले से संदर्भ में होते हैं। सत्र के अंत में एक memory miner सत्र के निर्णयों और सीखों को प्रोजेक्ट स्टेट में समाहित करता है। बिना key के ये LLM फीचर ईमानदारी से कुछ नहीं करते, और लाइफसाइकिल hooks स्टेट सेविंग की गारंटी बनाए रखते हैं।

### हमेशा सिंक में - आपके सभी टूल में

**`egc watch`** - एक बार चलाएं और आपके सभी टूल सिंक में रहेंगे। जब आप किसी भी टूल फाइल में संदर्भ संपादित करते हैं, तो परिवर्तन स्वचालित रूप से अन्य सभी टूल के साथ सिंक किया जाता है।

```
egc watch              # वर्तमान प्रोजेक्ट की निगरानी करें
egc watch /path/proj   # किसी विशिष्ट प्रोजेक्ट की निगरानी करें
egc watch --quiet      # आउटपुट दबाएं
```

### डैशबोर्ड - रीयल-टाइम मिशन कंट्रोल

अपने एजेंटों की हर टूल कॉल, टोकन और लागत -- लाइव ब्राउज़र में देखें। `egc init` के बाद स्वचालित रूप से शुरू होता है। [पूरी गाइड](docs/installation.md#dashboard)

---

## प्रॉम्प्ट लाइब्रेरी

**479 घटक**: वैकल्पिक। वास्तविक अनुभव से लिखे गए 63 एजेंट, 229 कौशल (skills), और 76 कमांड तक पहुंच प्राप्त करने के लिए इंस्टॉल करें। यदि आप उन्हें छोड़ देते हैं, तब भी EGC आपको स्थायी मेमोरी देता है।

| घटक | कुल | Claude Code | Gemini CLI | Claude Code native |
|---|---|---|---|---|
| एजेंट | 63 | साझा (AGENTS.md) | साझा (AGENTS.md) | 12 |
| कमांड | 76 | साझा | निर्देश-आधारित | 31 |
| कौशल (Skills) | 229 | साझा | 10 (नेटिव प्रारूप) | 37 |
| नियम | 111 |: |: |: |

---

## EGC का समर्थन करें

EGC एक डेवलपर द्वारा बनाया गया है, खुले में प्रबंधित किया जाता है, और मुफ़्त है।

- **[Discord में शामिल हों](https://discord.gg/AtazrtxJ)**: प्रश्न पूछें, फीडबैक साझा करें
- **[GitHub पर प्रायोजित करें](https://github.com/sponsors/Fmarzochi)**: कोई भी राशि
- **[PayPal के माध्यम से दान करें](https://www.paypal.com/donate/?business=fmarzochi%40gmail.com&currency_code=USD)**: किसी GitHub खाते की आवश्यकता नहीं है
- **रिपॉजिटरी को स्टार दें**: अन्य डेवलपर्स को इसे खोजने में मदद मिलती है
- **[योगदान दें](../../.github/CONTRIBUTING.md)**: एजेंट, कौशल, कमांड, बग फिक्स, दस्तावेज़
- **साझा करें**: यदि EGC ने आपके काम करने के तरीके को बदल दिया है, तो किसी को बताएं

### प्रायोजक

समुदाय का समर्थन इस परियोजना को जीवित और स्वतंत्र रखता है।

#### टूल पार्टनर

AI कोडिंग टूल जो EGC के साथ नेटिव रूप से एकीकृत होते हैं। पार्टनर्स को सभी READMEs और EGCSite पर लोगो प्लेसमेंट मिलती है।

<a href="https://www.pincushion.io/"><img src="https://www.pincushion.io/logo-icon.png" width="52" height="52" alt="Pincushion" title="Pincushion" /></a>

#### वार्षिक प्रायोजक · _पहले वार्षिक प्रायोजक बनें._

---

#### समर्थक (Backers)

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a> <a href="https://github.com/muhammadhasnain3031"><img src="https://avatars.githubusercontent.com/u/262106526?v=4" width="48" height="48" alt="@muhammadhasnain3031" title="@muhammadhasnain3031 -- Hindi translation" /></a>

#### मासिक प्रायोजक · _पहले बनें_

---

<div align="center">

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE) [![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;
<a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
