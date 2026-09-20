<!-- LANGUAGE-SELECTOR-START -->

🌐 [English](../../README.md) · **العربية** · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [Türkçe](../tr/README.md) · [简体中文](../zh-CN/README.md)

<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/images/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

<div align="center">

# EGC - منح كل عامل ذكاء الذكاء نفس الدماغ

**محرك محلي واحد يعطي كل أداة برمجة الذكاء الاصطناعي على جهازك نفس الذاكرة، نفس السكة الحارسة ونفس السياق، في كل جلسة.**

</div>

---

EGC هو وقت تشغيل محلي - أول لأدوات برمجة AI. قم بتثبيته مرة واحدة وكورسور، الكود البرمجي، الكود كوبيلوت، أشبه ببقية أدوات برمجة الذكاء الاصطناعي الـ 20 التي يدعمها يشاركون ذاكرة مشفرة واحدة لمشاريعك، طبقة أمان واحدة أمام كل أمر، فلتر واحد يبقي الإخراج الضوئي بعيدا عن النموذج، وحافلة حية واحدة تتيح للجلسات المفتوحة رؤية بعضها البعض. يعمل مع كلاود, GPT-4o, Gemini, DeepSeek, Mistral, Groq, Cohere, and Vertex AI, بالإضافة إلى OpenRouter لـ Qwen3, Llama 4, وغيرها.

لا شيء يترك آلتك. الذاكرة تعيش في '~/.egc', مشفرة مع AES-256-GCM, محتفظ بها لكل مشروع وفرع, ولا تلتزم أبداً بالغاية.

---

## تثبيت

```bash
npm install -g @egchq/egc && egc install
```

هذا هو المحرك بأكمله. 'egc install' يكشف الأدوات التي لديك، ويسجل خواديم MCP المحلية في كل منهم، يكتب بروتوكول الذاكرة كل وكيل يقرأ، ويضع رمز كريشر. يطرح سؤالاً واحداً، ما إذا كنت تريد أيضًا مكتبة الدعوة الاختيارية، والإفتراضي هو لا.

<div align="center">
  <img src="../../assets/gifs/install.gif" alt="One command installs EGC across 20 AI coding tools" width="800" />
</div>

[دليل التثبيت الكامل](../../docs/installation.md)

---

## المهندس: كيفية عمل EGC

إي إس إس إس إم هي دماغ واحد له أربع كليات كل واحد منها يعمل منذ التثبيت الأول، في كل أداة مدعومة، بدون أمر للتعلم.

<div align="center">
  <img src="../../assets/gifs/sharedbrain.gif" alt="A decision made in Cursor is already known in Claude Code" width="900" />
</div>

### الذاكرة: ما يتعلمه وكيل واحد، كل عامل يعرفه

القرارات وسياق الجلسات والذاكرة العملية والدروس المستفادة يتم إلتقاطها أثناء عملك، وهي متاحة في أي محطة طرفية أخرى أو في أي وكيل تفتحه. أنتِ تتكلمين، بطبيعة الحال، بأي لغة: "حفظ هذه الجلسة"، "ماذا قررنا بشأن الكتابة؟"، "تذكر هذا القرار". وتفهم لجنة الحكم الذاتي النيّة وتخزينها أو تذكّر بالسياق. لا يوجد أمر بالحفظ.

### شبكة الجلسة: الجلسات المفتوحة الخاصة بك راجع بعضها البعض

يشترك اثنان من علامات تبويب المؤشر، ومحطة كلود للبرمجة الطرفية وجلسة مضادة للجاذبية في حافلة حية واحدة. إنهم يعلنون ما يعملون عليه، ويطالبون بالملفات التي يعدلونها، العمل اليدوي لبعضهما البعض والتقاط الأحداث في اللحظة التي تهبط فيها، لذلك فإن الجلسات الموازية تتعاون بدلاً من الصدام .

### الحارس: طبقة أمان في جبهة كل قيادة

يقوم الحارس بالتحقق من صحة الأوامر قبل تشغيلها، ويكتب البوابات المحفوفة بالمخاطر ويمنع السياق من الإفراط، في الخلفية، دون أن تستدعي أي شيء. تعتمد التغطية على دعم الربط الخاص بكل أداة؛ [تقييم الأمن](../../docs/security/SECURITY-ASSESSMENT.md#known-limitations) يوثق الاستثناء.

### صخور رمزية : الضوضاء لا تصل أبدا إلى النموذج

قبل أن يصل إخراج القذيفة إلى النموذج، تضغط قذيفة القذيفة الرمزية على سجلات git واختبار الرسائل غير المرغوب فيها، قم بتثبيت الضوضاء وعملاق JSON بنسبة تصل إلى 90% مع الحفاظ على كل خطأ وتحذير. اسألي "كم قمت بتوفير؟" في أي لغة والإجابة تأتي مباشرة من دفتر الأستاذ المحلي الخاص بك.

---

## بداية سريعة

ولا توجد خطوة ثانية. افتح أي من أدوات الذكاء الاصطناعي الخاصة بك وتحدث فقط: "مرحباً"، "دعونا نواصل"، "تذكر هذا القرار"، بأي لغة. الجلسات متصلة، أحمال الذاكرة، وكل علامة تبويب مفتوحة تعرف بالفعل ما يفعله الآخرون.

تبدأ لوحة تحكم حية مع نشاط الوكيل والرموز المميزة والتكاليف مباشرة بعد التثبيت. تفضيل السيطرة الصريحة؟ يتم توثيق كل أمر في [دليل التثبيت](../../docs/installation.md): على الأرجح لن تحتاج أبدا إلى كتابة واحد.

---

## المكتبة الفورية (اختياري)

بمعزل عن المحرك، وإيقافه بشكل افتراضي، يشحن EGC أيضا مكتبة مكتوبة من جلسات الهندسة الحقيقية: يمكنك الوصول إلى 61 وكيلا، 232 مهارة و 77 أمر بالإضافة إلى 109 قواعد. الأخصائيون الذين يراجعون تعليماتك البرمجية بمفردهم، دليل أفضل الممارسات لكل لغة وموقف، الاختصارات التي تشغل سلسلة كاملة من المهام، وقواعد النمط التي تحافظ على اتساق التعليمات البرمجية الخاصة بك. أضفه إلى كل أداة تم اكتشافها مع `egc install --prompt-library'، أو إلى أداة واحدة مع `egc install --target <tool> --كامل الملف الشخصي. تخطي الأمر والمحرك يعمل بنفس الدرجة.

---

🌐 [English](../../README.md) · **العربية** · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [Türkçe](../tr/README.md) · [简体中文](../zh-CN/README.md)

---

## دعم EGC

يتم بناء EGC من قبل مطور واحد، يتم الحفاظ عليه في إطار مفتوح ومجاني. المحرك هو Apache-2. والبقاء مجاناً: إذا كانت EGC تقدم شيئًا مدفوعًا، ستكون طبقة فريق فوقها، لن تكون الذاكرة على جهازك.

- **[Website](https://fmarzochi.github.io/EGCSite)**: المستندات الكاملة، استعراض الميزات، العرض التجريبي الحي
- **[Vision](../../docs/VISION.md)**: إلى أين تذهب EGC وما تبقى مجانا
- **[انضم إلى ديسكورد](https://discord.gg/TxppsGb52)**: طرح أسئلة، شارك الملاحظات
- **[راعي على GitHub](https://github.com/sponsors/Fmarzochi)**: أي مبلغ
- **[تبرع عبر PayPal](https://www.paypal.com/donate/?business=fmarzochi%40gmail.com&currency_code=USD)**: لا حاجة إلى حساب GitHub
- **نجم المستودع**: يساعد المطورين الآخرين على العثور عليه
- **[Contribute](../../.github/CONTRIBUTING.md)**: الوكلاء، المهارات، الأوامر، إصلاحات الشوائب، مستندات
- **مشاركة**: إذا غيرت EGC طريقة عملك، أخبر شخصا ما

### الراعيون

ويبقي الدعم المقدم من المجتمع هذا المشروع حيا ومستقلا.

#### شركاء الأدوات

أدوات برمجة الذكاء الاصطناعي التي تدمج محلياً مع EGC. يحصل الشركاء على وضع الشعار عبر جميع READMEs و EGCSite.

<a href="https://www.pincushion.io/"><img src="https://www.pincushion.io/logo-icon.png" width="52" height="52" alt="Pincushion" title="Pincushion" /></a>

#### الجهات الراعية السنوية · - كن أول جهة راعية سنوية._

---

#### الداعمون

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a>

#### الرعاية الشهرية · _كن أول _

---

<div align="center">

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099[![OpenSSF Baseline level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF المستوى الأساسي 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp; <a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
