<!-- LANGUAGE-SELECTOR-START -->
🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · **हिन्दी** · [Italiano](../it/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [Türkçe](../tr/README.md) · [简体中文](../zh-CN/README.md)
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/images/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

<div align="center">

# EGC - हर AI एजेंट को एक ही दिमाग़ दें

**ऐसी स्थायी मेमोरी जो हर AI एजेंट, IDE, टर्मिनल और सत्र अपने आप साझा करते हैं। कोई प्रॉम्प्ट याद नहीं रखना। कोई संदर्भ दोबारा नहीं बनाना। बस बात कीजिए।**

</div>

---

EGC कोई और मेमोरी टूल नहीं है। यह वह इंटेलिजेंस परत है जो हर AI को ऐसे काम करने देती है मानो वह पहले दिन से आपके प्रोजेक्ट में हो, Cursor, Copilot, Claude Code, Codex, Aider और किसी भी टर्मिनल एजेंट में (कुल 20 AI कोडिंग टूल)। Claude, GPT-4o, Gemini, DeepSeek, Mistral, Groq, Cohere और Vertex AI के साथ नेटिव रूप से काम करता है, साथ ही OpenRouter के ज़रिये Qwen3, Llama 4 और अधिक।

हर बातचीत आपके प्रोजेक्ट की सामूहिक बुद्धिमत्ता बढ़ाती है। हर एजेंट उसे विरासत में पाता है। हर सत्र और समझदार होता जाता है।

---

## इंस्टॉल

```bash
npm install -g @egchq/egc && egc install
```

- **संदर्भ की बर्बादी 90% तक घटाएँ, टोकन लागत कम करें, और हर AI को सत्रों के बीच पूरी तरह संरेखित रखें।**
- **Guardian: हर कमांड को चलने से पहले जाँचता है, ख़तरनाक writes को रोकता है और prompt injection पकड़ता है। हर साझा दिमाग़ में सुरक्षा परत पहले से बनी होती है।**
- **एक कमांड, शून्य कॉन्फ़िग: मेमोरी आपकी मशीन पर लोकल और एन्क्रिप्टेड रहती है, और कभी git में कमिट नहीं होती।**

<div align="center">
  <img src="../../assets/gifs/install.gif" alt="EGC install" width="800" />
</div>

[पूरा इंस्टॉलेशन गाइड](../../docs/installation.md)

---

## दिमाग़ के अंदर: EGC कैसे काम करता है

EGC टूलों की सूची नहीं है; यह कई क्षमताओं वाला एक दिमाग़ है। यह याद रखता है, समझता है, रक्षा करता है, छानता है और तालमेल बिठाता है, आपकी मशीन के हर AI एजेंट में।

<div align="center">
  <img src="../../assets/gifs/sharedbrain.gif" alt="Cursor to Claude Code shared memory" width="900" />
</div>

### कमांड याद नहीं रखने, स्वाभाविक रूप से बोलिए

किसी भी भाषा में दिमाग़ से बात कीजिए: "यह सत्र सहेजो", "auth के बारे में हमने क्या तय किया था?", "यह निर्णय याद रखो"। EGC इरादा समझता है, संदर्भ सहेजता है और मशीन के किसी भी दूसरे टैब, टर्मिनल या टूल में तुरंत वापस लाता है। एक दिमाग़। हर एजेंट। याद रखने के लिए शून्य कमांड।

### स्थायी प्रोजेक्ट मेमोरी

EGC हर AI एजेंट को एक स्थायी, साझा दिमाग़ देता है। यह निर्णय, सत्र का संदर्भ, कार्यशील मेमोरी और सीखे गए पैटर्न सहेजता है, और उन्हें आपके खोले किसी भी टर्मिनल, IDE या एजेंट में तुरंत उपलब्ध कराता है। सत्र की स्थिति, प्रोजेक्ट का इतिहास और संचित सबक़ टैब, टूल और साथियों के बीच सहज बहते हैं: न मैनुअल सिंक, न संदर्भ का नुक़सान। सारी मेमोरी आपकी मशीन पर `~/.egc` में रहती है, AES-256-GCM से एन्क्रिप्टेड, हर ब्रांच की अलग, और कभी रिपॉज़िटरी में कमिट नहीं होती।

### Guardian: बिल्ट-इन सुरक्षा रेलिंग

दिमाग़ का दूसरा आधा हिस्सा पृष्ठभूमि में सुरक्षा रेलिंग चलाता है। कमांड चलने से पहले जाँचता है, जोखिम भरी writes रोकता है, संदर्भ को छलकने से पहले संपीड़ित करता है, एजेंटों के बीच बहु-चरणीय कार्यों का संचालन करता है और हर सुधार से सीखता है, और आपको एक भी टूल बुलाना नहीं पड़ता। एक अदृश्य सुरक्षा जाल जो संदर्भ हल्का, कार्य सुरक्षित और वर्कफ़्लो स्वायत्त रखता है।

### Token Crusher: दिमाग़ याद रखने से पहले शोर छानता है

दिमाग़ सिर्फ़ याद नहीं रखता: छानता भी है। शेल का आउटपुट मॉडल तक पहुँचने से पहले EGC का Token Crusher git लॉग, टेस्ट का शोर, इंस्टॉल का स्पैम और विशाल JSON को 90% तक संपीड़ित करता है, हर त्रुटि और चेतावनी सुरक्षित रखते हुए। बस पूछिए "मैंने कितने टोकन बचाए?", किसी भी भाषा में, और जवाब आपके लोकल बहीखाते से शून्य लागत पर आ जाता है: सस्ते सत्र, लंबा चलने वाला संदर्भ।

---

## प्रॉम्प्ट लाइब्रेरी

बोनस के तौर पर EGC आपको 63 एजेंट, 230 स्किल और 77 कमांड, साथ में 111 नियम देता है: विशेषज्ञ जो ख़ुद आपका कोड रिव्यू करते हैं, हर भाषा और स्थिति के लिए सर्वोत्तम-अभ्यास गाइड, शॉर्टकट जो पूरे कार्य-क्रम चला देते हैं, और स्टाइल नियम जो कोड को एकरूप रखते हैं। सब असली इंजीनियरिंग सत्रों से लिखा गया, सिद्धांत से नहीं। कुछ भी इस्तेमाल नहीं करना चाहते? कोई बात नहीं: EGC की स्थायी मेमोरी बिल्कुल वैसे ही काम करती है।

---

## क्विक स्टार्ट

दूसरा कोई क़दम नहीं है। अपना कोई भी AI टूल खोलिए और बस बोलिए: "हाय", "आगे बढ़ते हैं", "यह निर्णय याद रखो", किसी भी भाषा में। सत्र अपने आप लॉग होता है, मेमोरी अपने आप लोड होती है, और हर खुला टैब पहले से जानता है कि बाक़ी क्या कर रहे हैं: Cursor के दो टैब, एक Claude Code टर्मिनल और एक Antigravity सत्र, सब एक ही जीवित संदर्भ एक साथ साझा करते हैं।

आपके एजेंटों की गतिविधि, टोकन और लागत दिखाने वाला लाइव पैनल इंस्टॉल के तुरंत बाद अपने आप शुरू हो जाता है। मैनुअल नियंत्रण चाहिए? हर कमांड [इंस्टॉलेशन गाइड](../../docs/installation.md) में दर्ज है: शायद आपको कभी एक भी टाइप करने की ज़रूरत न पड़े।

---

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · **हिन्दी** · [Italiano](../it/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [Türkçe](../tr/README.md) · [简体中文](../zh-CN/README.md)

---

## EGC का समर्थन करें

EGC एक डेवलपर द्वारा बनाया गया है, खुले में प्रबंधित किया जाता है, और मुफ़्त है।

- **[Discord में शामिल हों](https://discord.gg/TxppsGb52)**: प्रश्न पूछें, फीडबैक साझा करें
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

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a> <a href="https://github.com/muhammadhasnain3031"><img src="https://avatars.githubusercontent.com/u/262106526?v=4" width="48" height="48" alt="@muhammadhasnain3031" title="@muhammadhasnain3031, Hindi translation" /></a>

#### मासिक प्रायोजक · _पहले बनें_

---

<div align="center">

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;
<a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
