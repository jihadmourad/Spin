/* Customer flow: details -> Google review (required) -> spin (server decides) -> result.
 * Works in Arabic and English. The language choice is remembered on this device. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var t = function (key) { return window.I18n.t(key); };

  var els = {
    intro: $('intro'),
    steps: $('steps'),
    langToggle: $('lang-toggle'),
    form: $('entry-form'),
    formBtn: $('form-btn'),
    formError: $('form-error'),
    stepForm: $('step-form'),
    stepReview: $('step-review'),
    reviewLink: $('review-link'),
    confirmBtn: $('confirm-review-btn'),
    reviewError: $('review-error'),
    stepWheel: $('step-wheel'),
    canvas: $('wheel'),
    pointer: document.querySelector('.pointer'),
    spinBtn: $('spin-btn'),
    spinError: $('spin-error'),
    stepWin: $('step-win'),
    winPrize: $('win-prize'),
    stepLose: $('step-lose'),
    stepUsed: $('step-used'),
    usedMsg: $('used-msg'),
    igLink: $('link-instagram'),
    fbLink: $('link-facebook'),
  };

  var wheel = new window.SpinWheel(els.canvas, {
    onTick: function () {
      els.pointer.classList.remove('tick');
      void els.pointer.offsetWidth;
      els.pointer.classList.add('tick');
    },
  });

  var state = {
    token: null,
    reviewUrl: null,
    segments: [],     // from the server: {label, labelEn, isWin}
    segmentIndex: -1,
    result: null,     // {prize, prizeEn, isWin}
    spinning: false,
    celebration: null,
  };

  function show(el, on) { el.hidden = !on; }
  function reveal(el) {
    el.hidden = false;
    el.classList.remove('anim-in');
    void el.offsetWidth;
    el.classList.add('anim-in');
  }
  function setError(el, msg) { el.textContent = msg || ''; show(el, !!msg); }
  function setStep(n) {
    els.steps.querySelectorAll('li').forEach(function (li) {
      var s = Number(li.getAttribute('data-step'));
      li.classList.toggle('active', s === n);
      li.classList.toggle('done', s < n);
    });
  }
  function busy(btn, on, key) {
    btn.disabled = on;
    if (key) {
      btn.setAttribute('data-i18n', key);
      btn.textContent = t(key);
    }
  }

  // Server errors are shown in the page language, keyed by status code.
  function errorText(status, fallbackKey) {
    if (status === 0) return t('err.network');
    if (status === 403) return t('err.review_first');
    if (status === 409) return t('err.used');
    if (status === 503) return t('err.unavailable');
    return t(fallbackKey || 'err.generic');
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      credentials: 'same-origin',
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    }).catch(function () {
      return { ok: false, status: 0, data: {} };
    });
  }

  // Wheel labels follow the page language.
  function wheelLabels() {
    var en = window.I18n.lang() === 'en';
    return state.segments.map(function (s) {
      return { label: en ? (s.labelEn || s.label) : s.label };
    });
  }
  function redrawWheel() {
    wheel.setSegments(wheelLabels());
  }

  function showUsed(status) {
    show(els.stepForm, false);
    show(els.stepReview, false);
    show(els.stepWheel, false);
    els.usedMsg.textContent = errorText(status);
    reveal(els.stepUsed);
  }

  function showReview() {
    setStep(2);
    show(els.stepForm, false);
    reveal(els.stepReview);
    els.reviewLink.href = state.reviewUrl || '#';
  }

  function showWheel() {
    setStep(3);
    show(els.stepReview, false);
    reveal(els.stepWheel);
    els.stepWheel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Result card: a win celebrates; a "try again" field gets a gentle message.
  function showResult() {
    var r = state.result;
    if (!r) return;
    show(els.stepWin, false);
    show(els.stepLose, false);
    if (r.isWin) {
      els.winPrize.textContent = window.I18n.lang() === 'en' ? r.prizeEn : r.prize;
      reveal(els.stepWin);
      state.celebration = window.Celebrate.start({ duration: 4400 });
    } else {
      reveal(els.stepLose);
    }
    setStep(3);
    els.steps.querySelectorAll('li').forEach(function (li) { li.classList.add('done'); });
    (r.isWin ? els.stepWin : els.stepLose).scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function loadConfig() {
    return fetch('/api/config', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        state.segments = (cfg.segments || []).map(function (s) {
          return { label: s.label, labelEn: s.labelEn, isWin: s.isWin };
        });
        redrawWheel();
        els.igLink.href = cfg.links.instagram || '#';
        els.fbLink.href = cfg.links.facebook || '#';
        state.reviewUrl = cfg.links.googleReview || null;
        els.reviewLink.href = state.reviewUrl || '#';
      })
      .catch(function () {
        setError(els.formError, t('err.load'));
      });
  }

  // Language switch: relabel the wheel and any visible result in place.
  els.langToggle.addEventListener('click', function () {
    window.I18n.setLang(window.I18n.lang() === 'ar' ? 'en' : 'ar');
  });
  document.addEventListener('langchange', function () {
    redrawWheel();
    if (state.result && !els.stepWin.hidden) {
      els.winPrize.textContent = window.I18n.lang() === 'en' ? state.result.prizeEn : state.result.prize;
    }
  });

  // Step 1: register name + phone.
  els.form.addEventListener('submit', function (e) {
    e.preventDefault();
    setError(els.formError, '');
    var fd = new FormData(els.form);
    var name = String(fd.get('name') || '').trim();
    var phone = String(fd.get('phone') || '').trim();
    if (name.length < 2) return setError(els.formError, t('form.err.name'));
    if (!/^\+?[\d\s().-]{7,20}$/.test(phone)) return setError(els.formError, t('form.err.phone'));

    busy(els.formBtn, true, 'form.checking');
    postJson('/api/entries', { name: name, phone: phone }).then(function (res) {
      busy(els.formBtn, false, 'form.btn');
      if (res.status === 409) return showUsed(409);
      if (!res.ok) return setError(els.formError, errorText(res.status, 'err.generic'));

      state.token = res.data.token;
      if (res.data.googleReviewUrl) {
        state.reviewUrl = res.data.googleReviewUrl;
        els.reviewLink.href = state.reviewUrl;
      }
      show(els.intro, false);
      if (res.data.reviewConfirmed) showWheel(); else showReview();
    });
  });

  // Step 2: Google review. Clicking the link is recorded; confirming unlocks the wheel.
  els.reviewLink.addEventListener('click', function () {
    if (state.token) postJson('/api/review/click', { token: state.token });
  });

  els.confirmBtn.addEventListener('click', function () {
    setError(els.reviewError, '');
    busy(els.confirmBtn, true, 'review.confirming');
    postJson('/api/review/confirm', { token: state.token }).then(function (res) {
      busy(els.confirmBtn, false, 'review.confirm');
      if (!res.ok) return setError(els.reviewError, errorText(res.status, 'err.confirm'));
      showWheel();
    });
  });

  // Step 3: spin. The server refuses if the review was not confirmed.
  function spin() {
    if (state.spinning) return;
    state.spinning = true;
    setError(els.spinError, '');
    postJson('/api/spin', { token: state.token }).then(function (res) {
      if (res.status === 403) {
        state.spinning = false;
        busy(els.spinBtn, false, 'wheel.spin');
        show(els.stepWheel, false);
        return showReview();
      }
      if (res.status === 409) {
        state.spinning = false;
        return showUsed(409);
      }
      if (!res.ok) {
        state.spinning = false;
        busy(els.spinBtn, false, 'wheel.spin');
        return setError(els.spinError, errorText(res.status, 'err.generic'));
      }
      state.result = { prize: res.data.prize, prizeEn: res.data.prizeEn || res.data.prize, isWin: !!res.data.isWin };
      state.segmentIndex = res.data.segmentIndex;
      wheel.spinTo(state.segmentIndex, 5200).then(function () {
        state.spinning = false;
        show(els.spinBtn, false);
        els.stepWheel.classList.add('win');
        showResult();
      });
    });
  }

  els.spinBtn.addEventListener('click', function () {
    busy(els.spinBtn, true, 'wheel.spinning');
    spin();
  });

  loadConfig();
})();
