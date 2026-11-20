/* Arabic / English strings for the customer page. Arabic is the default.
 * Usage: data-i18n="key" on an element sets its text; data-i18n-ph sets a placeholder;
 * data-i18n-aria sets an aria-label. window.I18n.t(key) returns a string for scripts. */
(function () {
  'use strict';

  var STR = {
    ar: {
      title: 'رصيف | دوّر العجلة واربح',
      'lang.switch': 'English',
      'intro.h1': 'دوّر العجلة واربح',
      'intro.lead': 'ثلاث خطوات بسيطة، ثم فرصتك للفوز.',
      'steps.1': 'البيانات',
      'steps.2': 'التقييم',
      'steps.3': 'الدوران',
      'form.title': 'أدخل بياناتك',
      'form.name': 'الاسم',
      'form.phone': 'رقم الهاتف',
      'form.btn': 'متابعة',
      'form.checking': 'جارٍ التحقق...',
      'form.err.name': 'الرجاء إدخال الاسم (حرفين على الأقل)',
      'form.err.phone': 'الرجاء إدخال رقم هاتف صحيح',
      'review.title': 'اترك تقييماً لنا على Google',
      'review.text': 'لا يمكن الدوران قبل ترك التقييم. اضغط الزر، اكتب تقييمك، ثم ارجع إلى هذه الصفحة وأكّد.',
      'review.link': 'اترك تقييماً على Google',
      'review.confirm': 'لقد تركت التقييم',
      'review.confirming': 'جارٍ التأكيد...',
      'wheel.title': 'دوّر العجلة',
      'wheel.aria': 'عجلة الحظ',
      'wheel.spin': 'دوّر الآن',
      'wheel.spinning': 'جارٍ الدوران...',
      'win.eyebrow': 'مبروك!',
      'win.prize': 'ربحت',
      'win.show': 'أظهر هذه الشاشة للفريق لاستلام جائزتك.',
      'lose.eyebrow': 'حظاً أوفر',
      'lose.title': 'ليس هذه المرة',
      'lose.text': 'لم تربح هذه المرة، لكن شكراً لتقييمك وزيارتك رصيف. نراك قريباً!',
      'lose.result': 'النتيجة',
      'used.title': 'تمت المشاركة',
      'err.network': 'تعذّر الاتصال بالخادم، تحقق من الإنترنت وحاول مجدداً',
      'err.load': 'تعذّر تحميل الصفحة، حاول تحديثها',
      'err.review_first': 'يجب ترك تقييم على Google قبل الدوران',
      'err.used': 'هذا الرقم شارك في العجلة سابقاً',
      'err.unavailable': 'العجلة غير جاهزة حالياً، حاول لاحقاً',
      'err.generic': 'حدث خطأ، حاول مرة أخرى',
      'err.confirm': 'تعذّر تأكيد التقييم، حاول مجدداً',
      'follow': 'تابعنا',
      'brand': 'رصيف · Rassif',
    },
    en: {
      title: 'Rassif | Spin the wheel and win',
      'lang.switch': 'العربية',
      'intro.h1': 'Spin the wheel and win',
      'intro.lead': 'Three simple steps, then your chance to win.',
      'steps.1': 'Details',
      'steps.2': 'Review',
      'steps.3': 'Spin',
      'form.title': 'Your details',
      'form.name': 'Name',
      'form.phone': 'Phone number',
      'form.btn': 'Continue',
      'form.checking': 'Checking...',
      'form.err.name': 'Please enter your name (at least 2 characters)',
      'form.err.phone': 'Please enter a valid phone number',
      'review.title': 'Leave us a Google review',
      'review.text': 'You need to leave a review before you can spin. Tap the button, write your review, then come back here and confirm.',
      'review.link': 'Write a Google review',
      'review.confirm': 'I left my review',
      'review.confirming': 'Confirming...',
      'wheel.title': 'Spin the wheel',
      'wheel.aria': 'Prize wheel',
      'wheel.spin': 'Spin now',
      'wheel.spinning': 'Spinning...',
      'win.eyebrow': 'Congratulations!',
      'win.prize': 'You won',
      'win.show': 'Show this screen to our team to claim your prize.',
      'lose.eyebrow': 'So close',
      'lose.title': 'Not this time',
      'lose.text': 'No prize this time, but thank you for your review and for visiting Rassif. See you soon!',
      'lose.result': 'Result',
      'used.title': 'Already played',
      'err.network': 'Could not reach the server. Check your connection and try again.',
      'err.load': 'Could not load the page. Please refresh.',
      'err.review_first': 'Please leave a Google review before spinning.',
      'err.used': 'This number has already played.',
      'err.unavailable': 'The wheel is not ready right now. Please try later.',
      'err.generic': 'Something went wrong. Please try again.',
      'err.confirm': 'Could not confirm your review. Please try again.',
      'follow': 'Follow us',
      'brand': 'Rassif · رصيف',
    },
  };

  var KEY = 'rs_lang';
  var lang = 'ar';
  try {
    var saved = localStorage.getItem(KEY);
    if (saved === 'en' || saved === 'ar') lang = saved;
  } catch (e) { /* storage unavailable: stay on the default */ }

  function t(key) {
    var table = STR[lang] || STR.ar;
    return table[key] !== undefined ? table[key] : (STR.ar[key] !== undefined ? STR.ar[key] : key);
  }

  function apply() {
    var root = document.documentElement;
    root.lang = lang;
    root.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.title = t('title');
    document.body.classList.toggle('lang-en', lang === 'en');
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(function (el) {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
    });
  }

  function setLang(next) {
    if (next !== 'ar' && next !== 'en') return;
    lang = next;
    try { localStorage.setItem(KEY, lang); } catch (e) { /* ignore */ }
    apply();
    document.dispatchEvent(new CustomEvent('langchange', { detail: { lang: lang } }));
  }

  window.I18n = {
    t: t,
    apply: apply,
    setLang: setLang,
    lang: function () { return lang; },
  };

  apply();
})();
