<!-- LANGUAGE-SELECTOR-START -->
🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [简体中文](../zh-CN/README.md) · **Türkçe**
<!-- LANGUAGE-SELECTOR-END -->

<div align="center">
<img src="assets/images/hero.png" alt="EGC - Extended Global Context" width="100%" />
</div>

<div align="center">

# EGC - Her AI Agent'a Aynı Beyni Verin

**Her AI agent'ın, IDE'nin, terminalin ve oturumun otomatik olarak paylaştığı kalıcı bellek. Ezberlenecek prompt yok. Yeniden kurulacak context yok. Sadece konuşun.**

</div>

---

EGC sıradan bir bellek aracı değildir. Cursor, Copilot, Claude Code, Codex, Aider ve herhangi bir terminal agent'ı dahil olmak üzere toplam 20 AI kodlama aracında, her AI'ın projenizde ilk günden beri çalışıyormuş gibi hareket etmesini sağlayan zeka katmanıdır. Claude, GPT-4o, Gemini, DeepSeek, Mistral, Groq, Cohere ve Vertex AI ile doğrudan çalışır; ayrıca Qwen3, Llama 4 ve daha fazlası için OpenRouter'ı destekler.

Her konuşma projenizin kolektif zekasını geliştirir. Her agent bunu devralır. Her oturum daha akıllı hale gelir.

---

## Kurulum

```bash
npm install -g @egchq/egc && egc install
```

- **Context israfını %90'a kadar azaltın, token maliyetlerini düşürün ve her AI'ın oturumlar arasında tam uyumlu kalmasını sağlayın.**
- **Guardian: Her komutu çalıştırmadan önce doğrulayın, tehlikeli yazma işlemlerini engelleyin ve prompt injection girişimlerini tespit edin. Her paylaşılan beyin yerleşik bir güvenlik katmanıyla gelir.**
- **Tek komut, sıfır yapılandırma: bellek makinenizde yerel ve şifreli kalır, git'e asla commit edilmez.**

<div align="center">
  <img src="assets/gifs/install.gif" alt="One command installs EGC across 20 AI coding tools" width="800" />
</div>

[Tam kurulum rehberi](docs/installation.md)

---

## Beynin İçinde: EGC Nasıl Çalışır

EGC bir araç listesi değildir; farklı yeteneklere sahip tek bir beyindir. Makinenizdeki tüm AI agent'lar arasında hatırlar, anlar, korur, filtreler ve koordinasyon sağlar.

<div align="center">
  <img src="assets/gifs/sharedbrain.gif" alt="A decision made in Cursor is already known in Claude Code" width="900" />
</div>

### Komut Ezberlemezsiniz, Doğal Konuşursunuz

Beyinle herhangi bir dilde konuşun: "bu oturumu kaydet", "auth hakkında neye karar vermiştik?", "bu kararı hatırla". EGC niyeti anlar, context'i saklar ve makinenizdeki başka bir sekmede, terminalde veya araçta anında geri çağırır. Tek beyin. Her agent. Ezberlenecek sıfır komut.

### Kalıcı Proje Belleği

EGC her AI agent'a kalıcı ve paylaşılan bir beyin verir. Kararları, oturum context'ini, çalışma belleğini ve öğrenilmiş kalıpları yakalar; ardından bunları açtığınız herhangi bir terminalde, IDE'de veya agent'ta anında kullanılabilir hale getirir. Oturum durumu, proje geçmişi ve biriken dersler sekmeler, araçlar ve ekip arkadaşları arasında kesintisiz akar: manuel senkronizasyon yok, context kaybı yok. Tüm bellek makinenizde `~/.egc` içinde yaşar, AES-256-GCM ile şifrelenir, proje branch'i bazında tutulur ve repository'nize asla commit edilmez.

### Guardian: Yerleşik Güvenlik Önlemleri

Beynin diğer yarısı arka planda koruma mekanizmalarını çalıştırır. Tek bir aracı bile elle çağırmanıza gerek kalmadan komutları çalışmadan önce doğrular, riskli yazma işlemleri için güvenlik kapısı uygular, context taşmadan önce sıkıştırır, çok adımlı görevleri agent'lar arasında orkestre eder ve her düzeltmeden öğrenir. Context'i hafif, eylemleri güvenli ve workflow'ları otonom tutan görünmez bir güvenlik ağıdır.

### Token Crusher: Beyin Hatırlamadan Önce Gürültüyü Filtreler

Beyin yalnızca hatırlamaz; aynı zamanda filtreler. Herhangi bir shell çıktısı modele ulaşmadan önce EGC'nin Token Crusher'ı git log'larını, test kalabalığını, kurulum gürültüsünü ve dev JSON'ları %90'a kadar sıkıştırır; tüm hata ve uyarıları korur. Herhangi bir dilde sadece "ne kadar tasarruf ettim?" diye sorun; yanıt sıfır maliyetle doğrudan yerel kayıt defterinizden gelir: daha ucuz oturumlar, daha uzun ömürlü context.

---

## Prompt Kütüphanesi

Bonus olarak EGC size 63 agent, 230 skill, 77 command ve ayrıca 111 rule'a erişim sağlar: Kodunuzu kendi başına inceleyen uzmanlar, her dil ve durum için best-practice rehberleri, sizin için tüm bir görev dizisini çalıştıran kısayollar ve kodunuzu tutarlı tutan stil kuralları. Hepsi teoriden değil, gerçek mühendislik oturumlarından yazıldı. Hiçbirini kullanmak istemiyor musunuz? Sorun değil: EGC'nin kalıcı belleği tamamen aynı şekilde çalışır.

---

## Hızlı Başlangıç

İkinci adım yok. AI araçlarınızdan herhangi birini açın ve herhangi bir dilde konuşmaya başlayın: "merhaba", "devam edelim", "bu kararı hatırla". Oturumlar anında bağlanır, bellek otomatik yüklenir ve açık olan her sekme diğerlerinin ne yaptığını zaten bilir: iki Cursor sekmesi, bir Claude Code terminali ve bir Antigravity oturumu aynı canlı context'i eşzamanlı olarak paylaşır.

Agent etkinliğini, token'ları ve maliyetleri gösteren canlı bir dashboard kurulumdan hemen sonra otomatik olarak başlar. Manuel kontrol mü tercih ediyorsunuz? Her komut [kurulum rehberinde](docs/installation.md) belgelenmiştir; büyük olasılıkla hiçbirini yazmanız gerekmeyecek.

---
🌐 [English](../../README.md) · [العربية](../ar/README.md) · [Español](../es/README.md) · [Français](../fr/README.md) · [हिन्दी](../hi/README.md) · [Italiano](../it/README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [Português (Brasil)](../pt/README.md) · [Русский](../ru/README.md) · [简体中文](../zh-CN/README.md) · **Türkçe**

---

## EGC'yi Destekleyin

EGC tek bir geliştirici tarafından geliştiriliyor, açık şekilde sürdürülüyor ve ücretsiz.

- **[Web sitesi](https://fmarzochi.github.io/EGCSite)**: tam dokümantasyon, özellik özeti ve canlı demo
- **[Discord'a katılın](https://discord.gg/TxppsGb52)**: soru sorun, geri bildirim paylaşın
- **[GitHub'da sponsor olun](https://github.com/sponsors/Fmarzochi)**: dilediğiniz tutarda
- **[PayPal ile bağış yapın](https://www.paypal.com/donate/?business=fmarzochi%40gmail.com&currency_code=USD)**: GitHub hesabı gerekmez
- **Repository'ye star verin**: diğer geliştiricilerin bulmasına yardımcı olur
- **[Katkıda bulunun](.github/CONTRIBUTING.md)**: agent'lar, skill'ler, command'lar, hata düzeltmeleri, dokümantasyon
- **Paylaşın**: EGC çalışma şeklinizi değiştirdiyse birine anlatın

### Sponsorlar

Topluluğun desteği bu projeyi canlı ve bağımsız tutar.

#### Tool Partnerleri

EGC ile doğrudan entegre olan AI kodlama araçları. Partnerlerin logoları tüm README'lerde ve EGCSite'ta yer alır.

<a href="https://www.pincushion.io/"><img src="https://www.pincushion.io/logo-icon.png" width="52" height="52" alt="Pincushion" title="Pincushion" /></a>

#### Yıllık Sponsorlar Â· _İlk yıllık sponsor olun._

---

#### Destekçiler

<a href="https://github.com/chizormaangel-commits"><img src="https://avatars.githubusercontent.com/u/291871326?v=4" width="52" height="52" alt="@chizormaangel-commits" title="@chizormaangel-commits" /></a>

#### Aylık sponsorlar Â· _ilk siz olun_

---

<div align="center">

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13099/badge)](https://www.bestpractices.dev/projects/13099) [![OpenSSF Baseline Level 1](https://www.bestpractices.dev/projects/13099/badge?level=baseline-1)](https://www.bestpractices.dev/projects/13099?level=baseline-1) [![OpenSSF Baseline Level 2](https://www.bestpractices.dev/projects/13099/badge?level=baseline-2)](https://www.bestpractices.dev/projects/13099?level=baseline-2) [![OpenSSF Baseline Level 3](https://www.bestpractices.dev/projects/13099/badge?level=baseline-3)](https://www.bestpractices.dev/projects/13099?level=baseline-3)

<br>

<a href="https://bestpractices.dev/projects/13099"><img src="assets/images/openssf-best-practices-badge.svg" alt="OpenSSF Best Practices" width="110" /></a>
&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;&emsp;
<a href="https://www.linkedin.com/in/felipemarzochi"><img src="assets/images/egc-logo.png" alt="EGC" width="110" /></a>

</div>
