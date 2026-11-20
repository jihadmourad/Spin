/* Page flow: form -> spin (server decides) -> Google review gate -> prize confirmed. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    intro: $('intro'),
    form: $('entry-form'),
    formError: $('form-error'),
    spinBtn: $('spin-btn'),
    wheelSection: $('wheel-section'),
    canvas: $('wheel'),
    result: $('step-result'),
    prize: $('prize-label'),
    reviewLink: $('review-link'),
    confirmBtn: $('confirm-review-btn'),
    reviewError: $('review-error'),
    done: $('step-done'),
    donePrize: $('done-prize'),
    used: $('step-used'),
    usedMsg: $('used-msg'),
    stepForm: $('step-form'),
    igLink: $('link-instagram'),
    fbLink: $('link-facebook'),
  };

  var wheel = new window.SpinWheel(els.canvas);
  var state = { token: null, reviewUrl: null, segmentIndex: -1 };

  function show(el, on) { el.hidden = !on; }
  function setError(el, msg) { el.textContent = msg || ''; show(el, !!msg); }

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
    });
  }

  function loadConfig() {
    return fetch('/api/config', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        wheel.setSegments(cfg.segments || []);
        els.igLink.href = cfg.links.instagram || '#';
        els.fbLink.href = cfg.links.facebook || '#';
        els.reviewLink.href = cfg.links.googleReview || '#';
        state.reviewUrl = cfg.links.googleReview || null;
      })
      .catch(function () {
        setError(els.formError, 'تعذّر تحميل العجلة، حاول تحديث الصفحة');
      });
  }

  els.form.addEventListener('submit', function (e) {
    e.preventDefault();
    setError(els.formError, '');
    var fd = new FormData(els.form);
    var name = String(fd.get('name') || '').trim();
    var phone = String(fd.get('phone') || '').trim();
    if (name.length < 2) return setError(els.formError, 'الرجاء إدخال الاسم (حرفين على الأقل)');
    if (!/^\+?[\d\s().-]{7,20}$/.test(phone)) return setError(els.formError, 'الرجاء إدخال رقم هاتف صحيح');

    els.spinBtn.disabled = true;
    postJson('/api/spin', { name: name, phone: phone }).then(function (res) {
      els.spinBtn.disabled = false;
      if (!res.ok) {
        if (res.status === 409) {
          show(els.stepForm, false);
          els.usedMsg.textContent = res.data.error;
          show(els.used, true);
          return;
        }
        return setError(els.formError, res.data.error || 'حدث خطأ، حاول مرة أخرى');
      }
      state.token = res.data.token;
      state.reviewUrl = res.data.googleReviewUrl || state.reviewUrl;
      if (state.reviewUrl) els.reviewLink.href = state.reviewUrl;
      state.segmentIndex = res.data.segmentIndex;
      state.prize = res.data.prize;
      show(els.stepForm, false);
      show(els.intro, false);
      show(els.wheelSection, true);
      // Spin automatically once the form is submitted.
      startSpin();
    });
  });

  function startSpin() {
    wheel.spinTo(state.segmentIndex, 5200).then(function () {
      els.prize.textContent = state.prize;
      els.donePrize.textContent = state.prize;
      show(els.result, true);
      els.result.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  els.reviewLink.addEventListener('click', function () {
    if (state.token) postJson('/api/review/click', { token: state.token });
  });

  els.confirmBtn.addEventListener('click', function () {
    setError(els.reviewError, '');
    els.confirmBtn.disabled = true;
    postJson('/api/review/confirm', { token: state.token }).then(function (res) {
      els.confirmBtn.disabled = false;
      if (!res.ok) return setError(els.reviewError, res.data.error || 'تعذّر تأكيد التقييم');
      show(els.result, false);
      show(els.wheelSection, false);
      show(els.done, true);
    });
  });

  loadConfig();
})();
