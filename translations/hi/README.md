<!-- LANGUAGE-SELECTOR-START -->

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · **हिन्दी** · [Italiano](../it/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [Türkçe](../tr/README.md) · [简体中文](../zh-CN/README.md)

<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/images/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

<div align="center">

# EGC - हर AI एजेंट को एक ही दिमाग़ दें

**एक लोकल इंजन जो आपकी मशीन के हर AI कोडिंग टूल को, हर सत्र में, वही मेमोरी, वही सुरक्षा रेलिंग और वही संदर्भ देता है।**

</div>

---

EGC AI कोडिंग टूलों के लिए एक लोकल-फ़र्स्ट रनटाइम है। इसे एक बार इंस्टॉल कीजिए, और Cursor, Claude Code, Codex, Copilot, Aider और इसके समर्थित 20 AI कोडिंग टूलों में से बाक़ी सब आपके प्रोजेक्टों की एक एन्क्रिप्टेड मेमोरी, हर कमांड के आगे खड़ी एक सुरक्षा परत, शोर भरे आउटपुट को मॉडल से दूर रखने वाला एक फ़िल्टर, और एक लाइव बस साझा करते हैं जिससे आपके खुले सत्र एक-दूसरे को देख पाते हैं। Claude, GPT-4o, Gemini, DeepSeek, Mistral, Groq, Cohere और Vertex AI के साथ नेटिव रूप से काम करता है, साथ ही OpenRouter के ज़रिये Qwen3, Llama 4 और अधिक।

आपकी मशीन से कुछ बाहर नहीं जाता। मेमोरी `~/.egc` में रहती है, AES-256-GCM से एन्क्रिप्टेड, हर प्रोजेक्ट और ब्रांच की अलग, और कभी git में कमिट नहीं होती।

---

## इंस्टॉल

```bash
npm install -g @egchq/egc && egc install
```

बस, यही पूरा इंजन है। `egc install` आपके टूल पहचानता है, हर एक में दोनों लोकल MCP सर्वर रजिस्टर करता है, वह मेमोरी प्रोटोकॉल लिखता है जिसे हर एजेंट पढ़ता है, और Token Crusher सेट करता है। यह सिर्फ़ एक सवाल पूछता है, क्या आप वैकल्पिक प्रॉम्प्ट लाइब्रेरी भी चाहते हैं, और डिफ़ॉल्ट जवाब नहीं है।

<div align="center">
  <img src="../../assets/gifs/install.gif" alt="One command installs EGC across 20 AI coding tools" width="800" />
</div>

[पूरा इंस्टॉलेशन गाइड](../../docs/installation.md)

---

## इंजन: EGC कैसे काम करता है

EGC चार क्षमताओं वाला एक दिमाग़ है। हर क्षमता पहले इंस्टॉल से ही, हर समर्थित टूल में, बिना कोई कमांड सीखे चालू रहती है।

<div align="center">
  <img src="../../assets/gifs/sharedbrain.gif" alt="A decision made in Cursor is already known in Claude Code" width="900" />
</div>

### मेमोरी: जो एक एजेंट सीखता है, हर एजेंट जानता है

निर्णय, सत्र का संदर्भ, कार्यशील मेमोरी और सीखे गए सबक़ काम करते-करते दर्ज होते हैं और आपके खोले किसी भी दूसरे टर्मिनल, IDE या एजेंट में उपलब्ध रहते हैं। आप किसी भी भाषा में स्वाभाविक रूप से बोलते हैं: "यह सत्र सहेजो", "auth के बारे में हमने क्या तय किया था?", "यह निर्णय याद रखो"। EGC इरादा समझता है और संदर्भ सहेजता या वापस लाता है। याद रखने के लिए कोई कमांड नहीं है।

### सेशन मेश: आपके खुले सत्र एक-दूसरे को देखते हैं

Cursor के दो टैब, एक Claude Code टर्मिनल और एक Antigravity सत्र एक ही लाइव बस साझा करते हैं। वे बताते हैं कि किस पर काम कर रहे हैं, जिन फ़ाइलों को संपादित करते हैं उन पर दावा करते हैं, एक-दूसरे को काम सौंपते हैं और घटनाओं को आते ही उठा लेते हैं, इसलिए समानांतर सत्र टकराने के बजाय सहयोग करते हैं।

### Guardian: हर कमांड के आगे खड़ी एक सुरक्षा परत

Guardian कमांडों को चलने से पहले जाँचता है, जोखिम भरी writes पर रोक लगाता है और संदर्भ को छलकने से बचाता है, पृष्ठभूमि में, बिना आपके कुछ बुलाए। कवरेज हर टूल के अपने hook समर्थन पर निर्भर करती है; अपवाद [सुरक्षा आकलन](../../docs/security/SECURITY-ASSESSMENT.md#known-limitations) में दर्ज है।

### Token Crusher: शोर कभी मॉडल तक नहीं पहुँचता

शेल का आउटपुट मॉडल तक पहुँचने से पहले Token Crusher git लॉग, टेस्ट का स्पैम, इंस्टॉल का शोर और विशाल JSON को 90 प्रतिशत तक संपीड़ित करता है, हर त्रुटि और चेतावनी सुरक्षित रखते हुए। किसी भी भाषा में पूछिए "मैंने कितना बचाया?", और जवाब सीधे आपके लोकल बहीखाते से आता है।

---

## क्विक स्टार्ट

दूसरा कोई क़दम नहीं है। अपना कोई भी AI टूल खोलिए और बस बोलिए: "हाय", "आगे बढ़ते हैं", "यह निर्णय याद रखो", किसी भी भाषा में। सत्र जुड़ जाते हैं, मेमोरी लोड हो जाती है, और हर खुला टैब पहले से जानता है कि बाक़ी क्या कर रहे हैं।

एजेंट की गतिविधि, टोकन और लागत दिखाने वाला लाइव डैशबोर्ड इंस्टॉल के तुरंत बाद शुरू हो जाता है। स्पष्ट नियंत्रण चाहिए? हर कमांड [इंस्टॉलेशन गाइड](../../docs/installation.md) में दर्ज है: शायद आपको कभी एक भी टाइप करने की ज़रूरत न पड़े।

---

## प्रॉम्प्ट लाइब्रेरी (वैकल्पिक)

इंजन से अलग, और डिफ़ॉल्ट रूप से बंद, EGC असली इंजीनियरिंग सत्रों से लिखी एक लाइब्रेरी भी साथ देता है: आपको 61 एजेंट, 232 स्किल और 77 कमांड, साथ में 109 नियम मिलते हैं। विशेषज्ञ जो ख़ुद आपका कोड रिव्यू करते हैं, हर भाषा और स्थिति के लिए सर्वोत्तम-अभ्यास गाइड, शॉर्टकट जो पूरे कार्य-क्रम चला देते हैं, और स्टाइल नियम जो कोड को एकरूप रखते हैं। इसे हर पहचाने गए टूल में जोड़ने के लिए `egc install --prompt-library` चलाइए, या एक टूल में `egc install --target <tool> --profile full`। इसे छोड़ दीजिए, इंजन बिल्कुल वैसे ही काम करता है।

---

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · **हिन्दी** · [Italiano](../it/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [Türkçe](../tr/README.md) · [简体中文](../zh-CN/README.md)

---

## EGC का समर्थन करें

EGC एक डेवलपर द्वारा बनाया गया है, खुले में प्रबंधित किया जाता है, और मुफ़्त है। इंजन Apache-2.0 है और मुफ़्त रहेगा: अगर EGC कभी कुछ सशुल्क देगा, तो वह इंजन के ऊपर एक टीम परत होगी, आपकी मशीन की मेमोरी कभी नहीं।

- **[वेबसाइट](https://fmarzochi.github.io/EGCSite)**: पूरा दस्तावेज़, फ़ीचर अवलोकन और लाइव डेमो
- **[विज़न](../../docs/VISION.md)**: EGC कहाँ जा रहा है, और क्या मुफ़्त रहेगा
- **[Discord में शामिल हों](https://discord.gg/FmXbgUmdmM)**: प्रश्न पूछें, फीडबैक साझा करें
- **[GitHub पर प्रायोजित करें](https://github.com/sponsors/Fmarzochi)**: कोई भी राशि
- **[PayPal के माध्यम से दान करें](https://www.paypal.com/donate/?business=fmarzochi%40gmail.com&currency_code=USD)**: किसी GitHub खाते की आवश्यकता नहीं है
- **रिपॉजिटरी को स्टार दें**: अन्य डेवलपर्स को इसे खोजने में मदद मिलती है
- **[योगदान दें](../../.github/CONTRIBUTING.md)**: एजेंट, कौशल, कमांड, बग फिक्स, दस्तावेज़
- **साझा करें**: यदि EGC ने आपके काम करने के तरीके को बदल दिया है, तो किसी को बताएं

### प्रायोजक

समुदाय का समर्थन इस परियोजना को जीवित और स्वतंत्र रखता है।

#### टूल पार्टनर

AI कोडिंग टूल जो EGC के साथ नेटिव रूप से एकीकृत होते हैं। पार्टनर्स को सभी READMEs और EGCSite पर लोगो प्लेसमेंट मिलता है।

<a href="https://www.pincushion.io/"><img src="https://www.pincushion.io/logo-icon.png" width="52" height="52" alt="Pincushion" title="Pincushion" /></a>

#### वार्षिक प्रायोजक · _पहले वार्षिक प्रायोजक बनें._

---

#### समर्थक

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a>

#### मासिक प्रायोजक · _पहले बनें_

---

<div align="center">

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp; <a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
