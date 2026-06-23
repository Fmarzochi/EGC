<!-- LANGUAGE-SELECTOR-START -->
**اللغة:** [English](../../README.md) | **العربية** | [Español](../es/README.md) | [Português (Brasil)](../pt/README.md) | [हिन्दी](../hi/README.md)
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

[![npm version](https://img.shields.io/npm/v/@egchq/egc?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/@egchq/egc) [![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org) [![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org) [![Discord](https://img.shields.io/discord/1513941515452416130?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/AtazrtxJ) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](../../.github/CONTRIBUTING.md) [![Stars](https://img.shields.io/github/stars/Fmarzochi/EGC?style=flat)](https://github.com/Fmarzochi/EGC/stargazers) [![Forks](https://img.shields.io/github/forks/Fmarzochi/EGC?style=flat)](https://github.com/Fmarzochi/EGC/network/members) [![Issues](https://img.shields.io/github/issues/Fmarzochi/EGC)](https://github.com/Fmarzochi/EGC/issues) [![Maintained](https://img.shields.io/badge/Maintained-yes-brightgreen)](https://github.com/Fmarzochi/EGC/commits/main) [![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/Fmarzochi/EGC?label=openssf+scorecard&style=flat)](https://securityscorecards.dev/viewer/?uri=github.com/Fmarzochi/EGC) [![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=alert_status)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=security_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=Fmarzochi_EGC&metric=reliability_rating)](https://sonarcloud.io/project/overview?id=Fmarzochi_EGC) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc) [![EGC MCP server](https://glama.ai/mcp/servers/Fmarzochi/EGC/badges/score.svg)](https://glama.ai/mcp/servers/Fmarzochi/EGC)

<!-- CENTERED-LANGUAGE-SELECTOR-START -->
<div align="center">

**اللغة / Idioma**

[English](../../README.md) | [**العربية**](README.md) | [Español](../es/README.md) | [Português (Brasil)](../pt/README.md) | [हिन्दी](../hi/README.md)

</div>
<!-- CENTERED-LANGUAGE-SELECTOR-END -->

<div align="center">

# EGC - السياق العالمي الممتد (Extended Global Context)

**وكلاؤك الآليون لن يبدأوا من الصفر مرة أخرى أبدًا.**

</div>

---

EGC هو وقت تشغيل محلي يمنح كل أداة برمجة تعتمد على الذكاء الاصطناعي تستخدمها ذاكرة مستمرة. في نهاية كل جلسة، يحفظ الذكاء الاصطناعي ما تعلمه عن مشروعك: القرارات التي اتخذتها، وما فشل، وتفضيلاتك، وما سيأتي بعد ذلك. في بداية الجلسة التالية، يقوم بتحميل تلك الحالة مرة أخرى. تثبيت واحد يغطي Claude Code و Cursor و Gemini CLI و Windsurf والمزيد.

---

## كيف يبدو EGC في الممارسة العملية

تفتح Claude Code في مشروع لم تلمسه منذ أسبوعين. دون كتابة أي شيء:

```
State loaded from egc-memory via ~/.egc/state/Projects--MyApp.md

Context and preferences acknowledged (terse responses).

Ready to pick up the next items:
• Test full install on a clean machine
• Add GEMINI.md with session memory protocol
• Publish v1.0.1 fix to npm after clean install test passes
• Add mcp_server_count to audit.js
```

يعرف الذكاء الاصطناعي بالفعل ما كنت تبنيه، والقرارات التي اتخذتها، وما فشل، وأين توقفت بالضبط. إنه يعرف لأن EGC حفظ تلك الحالة في نهاية جلستك الأخيرة وقام بتحميلها مرة أخرى عندما بدأت هذه الجلسة. لم تكتب أي شيء. لقد بدأت العمل فحسب.

<div align="center">
  <img src="../../assets/egc-terminal.gif" alt="EGC demo" width="700" />
</div>

---

## التثبيت

```bash
npm install -g @egchq/egc && egc install
```

أو التشغيل بدون تثبيت عالمي:

```bash
npx @egchq/egc install
```

[دليل التثبيت الكامل](../../docs/installation.md)

---

## ما يمنحه خادم MCP للذكاء الاصطناعي الخاص بك

يأتي EGC مع `egc-memory`، وهو خادم MCP يعرض 14 أداة يمكن للذكاء الاصطناعي استدعاؤها خلال الجلسة:

| الأداة | ماذا تفعل |
|---|---|
| `get_state` | يحمل ذاكرة المشروع عند بدء الجلسة |
| `update_state` | يحفظ القرارات والتفضيلات والخطوات التالية |
| `store_decision` | يحفظ قراراً واحداً في SQLite |
| `query_history` | يعيد القرارات السابقة حسب الطابع الزمني |
| `search_history` | بحث كامل في النص مع تصنيف BM25 |
| `working_memory_set` | يخزن سياقاً عابراً مع وقت انتهاء الصلاحية (TTL) |
| `working_memory_get` | يقرأ مفتاحاً عابراً |
| `working_memory_list` | يسرد جميع الإدخالات العابرة الحية للمشروع الحالي |
| `lesson_save` | يسجل المعرفة عبر الجلسات مع تضاؤل الثقة |
| `lesson_recall` | يسترجع الدروس النشطة فوق عتبة ثقة معينة |
| `lesson_reinforce` | يعزز الثقة في درس عندما يتكرر نفس النمط |
| `detect_patterns` | يبرز الأوامر المتكررة والأخطاء المتكررة من أحداث الخطاف (hook events) |
| `compress_observations` | يضغط ملاحظات الخطاف الخام إلى ملخصات مصنفة لتقليل استهلاك الرموز (tokens) |
| `get_project_state` | يعيد البيانات الوصفية لصحة الخادم وحالة محرك التخزين |

تعيش ملفات الحالة في `~/.egc/state/<project-slug>.md`. ملف واحد لكل مشروع، بصيغة Markdown بسيطة، وقابلة للقراءة من قبل البشر.

---

## مكتبة الأوامر (Prompt library)

**479 مكوناً**: اختيارية. قم بتثبيتها للوصول إلى 63 وكيلاً و 229 مهارة و 76 أمراً مكتوبة من تجربة حقيقية. تخطاها وسيظل EGC يمنحك ذاكرة مستمرة.

| المكون | الإجمالي | Claude Code | Gemini CLI | Claude Code native |
|---|---|---|---|---|
| الوكلاء (Agents) | 63 | Shared (AGENTS.md) | Shared (AGENTS.md) | 12 |
| الأوامر (Commands) | 76 | Shared | Instruction-based | 31 |
| المهارات (Skills) | 229 | Shared | 10 (native format) | 37 |
| القواعد (Rules) | 111 |: |: |: |

---

## دعم EGC

تم بناء EGC بواسطة مطور واحد، ويتم صيانته بشكل علني ومجاني.

- **[انضم إلى Discord](https://discord.gg/AtazrtxJ)**: اطرح الأسئلة وشارك التعليقات
- **[رعاية المشروع على GitHub](https://github.com/sponsors/Fmarzochi)**: أي مبلغ يساعد
- **[تبرع عبر PayPal](https://www.paypal.com/donate/?business=fmarzochi%40gmail.com&currency_code=USD)**: لا يلزم وجود حساب GitHub
- **ضع نجمة على المستودع**: يساعد المطورين الآخرين في العثور عليه
- **[المساهمة](../../.github/CONTRIBUTING.md)**: وكلاء، مهارات، أوامر، إصلاح أخطاء، وثائق
- **المشاركة**: إذا غير EGC طريقة عملك، أخبر أحداً بذلك

### الرعاة

دعم المجتمع يبقي هذا المشروع حياً ومستقلاً.

**الداعمون**

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="48" height="48" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a> <a href="https://github.com/muhammadhasnain3031"><img src="https://avatars.githubusercontent.com/u/262106526?v=4" width="48" height="48" alt="@muhammadhasnain3031" title="@muhammadhasnain3031 — Arabic translation" /></a>

**الرعاة الشهريون** · _كن الأول_

---

<div align="center">

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3) [![Socket](https://socket.dev/api/badge/npm/package/@egchq/egc)](https://socket.dev/npm/package/@egchq/egc)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;
<a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
