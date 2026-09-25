<!-- LANGUAGE-SELECTOR-START -->

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · **Türkçe** · [简体中文](../zh-CN/README.md)

<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="../../assets/images/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

<div align="center">

# EGC - Her AI Agent'a Aynı Beyni Verin

**Makinenizdeki her AI kodlama aracına, her oturumda aynı belleği, aynı güvenlik önlemlerini ve aynı context'i veren tek bir yerel motor.**

</div>

---

EGC, AI kodlama araçları için yerel öncelikli bir çalışma zamanıdır. Bir kez kurun; Cursor, Claude Code, Codex, Copilot, Aider ve desteklediği 20 AI kodlama aracının geri kalanı, projelerinizin tek bir şifreli belleğini, her komutun önünde duran tek bir güvenlik katmanını, gürültülü çıktıyı modelden uzak tutan tek bir filtreyi ve açık oturumlarınızın birbirini görmesini sağlayan tek bir canlı veri yolunu paylaşır. Claude, GPT-4o, Gemini, DeepSeek, Mistral, Groq, Cohere ve Vertex AI ile doğrudan çalışır; ayrıca Qwen3, Llama 4 ve daha fazlası için OpenRouter'ı destekler.

Hiçbir şey makinenizden dışarı çıkmaz. Bellek `~/.egc` içinde yaşar, AES-256-GCM ile şifrelenir, proje ve branch bazında tutulur ve git'e asla commit edilmez.

---

## Kurulum

```bash
npm install -g @egchq/egc && egc install
```

Motorun tamamı bu kadar. `egc install` sahip olduğunuz araçları tespit eder, her birine iki yerel MCP sunucusunu kaydeder, her agent'ın okuduğu bellek protokolünü yazar ve Token Crusher'ı kurar. Tek bir soru sorar: isteğe bağlı prompt kütüphanesini de ister misiniz, ve varsayılan yanıt hayırdır.

<div align="center">
  <img src="../../assets/gifs/install.gif" alt="One command installs EGC across 20 AI coding tools" width="800" />
</div>

[Tam kurulum rehberi](../../docs/installation.md)

---

## Motor: EGC Nasıl Çalışır

EGC, dört yeteneği olan tek bir beyindir. Her biri ilk kurulumdan itibaren, desteklenen her araçta, öğrenilecek tek bir komut olmadan açıktır.

<div align="center">
  <img src="../../assets/gifs/sharedbrain.gif" alt="A decision made in Cursor is already known in Claude Code" width="900" />
</div>

### Bellek: Bir Agent'ın Öğrendiğini Her Agent Bilir

Kararlar, oturum context'i, çalışma belleği ve öğrenilen dersler siz çalışırken yakalanır ve açtığınız başka herhangi bir terminalde, IDE'de veya agent'ta kullanılabilir olur. Herhangi bir dilde doğal konuşursunuz: "bu oturumu kaydet", "auth hakkında neye karar vermiştik?", "bu kararı hatırla". EGC niyeti anlar ve context'i saklar ya da geri çağırır. Ezberlenecek komut yoktur.

### Oturum Ağı: Açık Oturumlarınız Birbirini Görür

İki Cursor sekmesi, bir Claude Code terminali ve bir Antigravity oturumu tek bir canlı veri yolunu paylaşır. Ne üzerinde çalıştıklarını duyurur, düzenledikleri dosyaları üstlenir, işi birbirlerine devreder ve olayları geldiği anda yakalar; böylece paralel oturumlar çarpışmak yerine iş birliği yapar.

### Guardian: Her Komutun Önünde Bir Güvenlik Katmanı

Guardian komutları çalışmadan önce doğrular, riskli yazma işlemlerini kapıda tutar ve context'in taşmasını önler; arka planda, siz hiçbir şey çağırmadan. Kapsam her aracın kendi hook desteğine bağlıdır; istisna [Güvenlik Değerlendirmesi](../../docs/security/SECURITY-ASSESSMENT.md#known-limitations) içinde belgelenmiştir.

### Token Crusher: Gürültü Modele Asla Ulaşmaz

Shell çıktısı modele ulaşmadan önce Token Crusher git log'larını, test kalabalığını, kurulum gürültüsünü ve dev JSON'ları yüzde 90'a kadar sıkıştırır; her hatayı ve uyarıyı korur. Herhangi bir dilde "ne kadar tasarruf ettim?" diye sorun, yanıt doğrudan yerel kayıt defterinizden gelir.

---

## Hızlı Başlangıç

İkinci adım yok. AI araçlarınızdan herhangi birini açın ve sadece konuşun: "merhaba", "devam edelim", "bu kararı hatırla", herhangi bir dilde. Oturumlar bağlanır, bellek yüklenir ve açık olan her sekme diğerlerinin ne yaptığını zaten bilir.

Agent etkinliğini, token'ları ve maliyetleri gösteren canlı bir dashboard kurulumdan hemen sonra başlar. Açık kontrol mü tercih ediyorsunuz? Her komut [kurulum rehberinde](../../docs/installation.md) belgelenmiştir: büyük olasılıkla hiçbirini yazmanız gerekmeyecek.

---

## Prompt Kütüphanesi (İsteğe Bağlı)

Motordan ayrı ve varsayılan olarak kapalı olan EGC, gerçek mühendislik oturumlarından yazılmış bir kütüphane de sunar: 61 agent, 232 skill ve 77 command'a, ayrıca 109 rule'a erişirsiniz. Kodunuzu kendi başına inceleyen uzmanlar, her dil ve durum için best-practice rehberleri, tüm bir görev dizisini çalıştıran kısayollar ve kodunuzu tutarlı tutan stil kuralları. Tespit edilen her araca `egc install --prompt-library` ile, tek bir araca `egc install --target <tool> --profile full` ile ekleyin. Atlarsanız motor tamamen aynı şekilde çalışır.

---

🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Deutsch](../de/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · **Türkçe** · [简体中文](../zh-CN/README.md)

---

## EGC'yi Destekleyin

EGC tek bir geliştirici tarafından geliştiriliyor, açık şekilde sürdürülüyor ve ücretsiz. Motor Apache-2.0 lisanslıdır ve ücretsiz kalır: EGC bir gün ücretli bir şey sunarsa bu, motorun üzerine eklenen bir ekip katmanı olur, makinenizdeki bellek asla.

- **[Web sitesi](https://fmarzochi.github.io/EGCSite)**: tam dokümantasyon, özellik özeti ve canlı demo
- **[Vizyon](../../docs/VISION.md)**: EGC nereye gidiyor ve ne ücretsiz kalıyor
- **[Discord'a katılın](https://discord.gg/TxppsGb52)**: soru sorun, geri bildirim paylaşın
- **[GitHub'da sponsor olun](https://github.com/sponsors/Fmarzochi)**: dilediğiniz tutarda
- **[PayPal ile bağış yapın](https://www.paypal.com/donate/?business=fmarzochi%40gmail.com&currency_code=USD)**: GitHub hesabı gerekmez
- **Repository'ye star verin**: diğer geliştiricilerin bulmasına yardımcı olur
- **[Katkıda bulunun](../../.github/CONTRIBUTING.md)**: agent'lar, skill'ler, command'lar, hata düzeltmeleri, dokümantasyon
- **Paylaşın**: EGC çalışma şeklinizi değiştirdiyse birine anlatın

### Sponsorlar

Topluluğun desteği bu projeyi canlı ve bağımsız tutar.

#### Tool Partnerleri

EGC ile doğrudan entegre olan AI kodlama araçları. Partnerlerin logoları tüm README'lerde ve EGCSite'ta yer alır.

<a href="https://www.pincushion.io/"><img src="https://www.pincushion.io/logo-icon.png" width="52" height="52" alt="Pincushion" title="Pincushion" /></a>

#### Yıllık Sponsorlar · _İlk yıllık sponsor olun._

---

#### Destekçiler

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a>

#### Aylık sponsorlar · _ilk siz olun_

---

<div align="center">

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="../../assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp; <a href="https://www.linkedin.com/in/felipemarzochi"><img src="../../assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
