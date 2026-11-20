/* Admin dashboard. All user-supplied text is written with textContent, never innerHTML. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === 'class') node.className = props[k];
        else if (k === 'text') node.textContent = props[k];
        else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), props[k]);
        else node.setAttribute(k, props[k]);
      });
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function api(method, url, body) {
    var opts = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(function (res) {
      if (res.status === 401 && url !== '/api/admin/login') { showLogin(); throw new Error('session'); }
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || 'حدث خطأ');
        return data;
      });
    });
  }

  function fmtDate(sqlDate) {
    if (!sqlDate) return '';
    // SQLite datetime('now') is UTC without a zone marker.
    var d = new Date(sqlDate.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return sqlDate;
    return d.toLocaleString('ar-LB', { dateStyle: 'short', timeStyle: 'short' });
  }

  function badge(on) {
    return el('span', { class: 'badge ' + (on ? 'yes' : 'no'), text: on ? 'نعم' : 'لا' });
  }

  function showLogin() {
    $('app-view').hidden = true;
    $('login-view').hidden = false;
  }
  function showApp(username) {
    $('login-view').hidden = true;
    $('app-view').hidden = false;
    $('who').textContent = username;
    loadEntries();
    loadStats();
  }

  // ---- login ----
  $('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target;
    $('login-error').hidden = true;
    api('POST', '/api/admin/login', { username: f.username.value.trim(), password: f.password.value })
      .then(function (d) { f.password.value = ''; showApp(d.username); })
      .catch(function (err) { $('login-error').textContent = err.message; $('login-error').hidden = false; });
  });

  $('logout-btn').addEventListener('click', function () {
    api('POST', '/api/admin/logout').finally(showLogin);
  });

  // ---- tabs ----
  document.querySelectorAll('.tabs [data-tab]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var name = btn.getAttribute('data-tab');
      document.querySelectorAll('.tabs [data-tab]').forEach(function (b) {
        b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
      });
      document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
      $('tab-' + name).classList.add('active');
      if (name === 'entries') { loadEntries(); loadStats(); }
      if (name === 'wheel') loadSegments();
      if (name === 'settings') loadSettings();
      if (name === 'users') loadUsers();
    });
  });

  // ---- entries ----
  function loadStats() {
    api('GET', '/api/admin/stats').then(function (s) {
      var wrap = $('stats');
      wrap.textContent = '';
      [
        ['إجمالي المشاركات', s.entries],
        ['نقروا على التقييم', s.reviewClicked],
        ['أكّدوا التقييم', s.reviewConfirmed],
      ].forEach(function (pair) {
        wrap.appendChild(el('div', { class: 'stat' }, [
          el('div', { class: 'num', text: String(pair[1]) }),
          el('div', { class: 'lbl', text: pair[0] }),
        ]));
      });
      (s.byPrize || []).forEach(function (p) {
        wrap.appendChild(el('div', { class: 'stat' }, [
          el('div', { class: 'num', text: String(p.count) }),
          el('div', { class: 'lbl', text: p.prize }),
        ]));
      });
    }).catch(function () {});
  }

  var searchTimer = null;
  $('search').addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadEntries, 250);
  });

  function loadEntries() {
    var q = $('search').value.trim();
    api('GET', '/api/admin/entries?q=' + encodeURIComponent(q)).then(function (d) {
      var body = $('entries-body');
      body.textContent = '';
      d.entries.forEach(function (r) {
        body.appendChild(el('tr', null, [
          el('td', { text: r.name }),
          el('td', { class: 'ltr', text: r.phone }),
          el('td', { text: r.prize_label }),
          el('td', { text: fmtDate(r.spun_at) }),
          el('td', null, [badge(!!r.review_clicked_at)]),
          el('td', null, [badge(!!r.review_confirmed_at)]),
        ]));
      });
      $('entries-count').textContent = 'عدد النتائج: ' + d.entries.length;
    }).catch(function () {});
  }

  $('export-btn').addEventListener('click', function () {
    fetch('/api/admin/entries/export.xlsx', { credentials: 'same-origin' }).then(function (res) {
      if (res.status === 401) { showLogin(); throw new Error('session'); }
      if (!res.ok) throw new Error('فشل التصدير');
      return res.blob();
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = el('a', { href: url, download: 'rassif-spin-entries.xlsx' });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }).catch(function (err) { if (err.message !== 'session') alert(err.message); });
  });

  // ---- wheel segments ----
  var segState = { segments: [] };

  function loadSegments() {
    api('GET', '/api/admin/segments').then(function (d) {
      segState.segments = d.segments;
      renderSegments(d.totalWeight);
    }).catch(function () {});
  }

  function renderSegments(totalWeight) {
    var body = $('seg-body');
    body.textContent = '';
    var segs = segState.segments;
    segs.forEach(function (s, i) {
      var label = el('input', { type: 'text', value: s.label, maxlength: '40' });
      var weight = el('input', { type: 'number', min: '0', max: '100', step: '1', value: String(s.weight) });
      var active = el('input', { type: 'checkbox' });
      active.checked = !!s.active;
      var up = el('button', { type: 'button', class: 'btn btn-small', text: '↑', title: 'أعلى' });
      var down = el('button', { type: 'button', class: 'btn btn-small', text: '↓', title: 'أسفل' });
      up.disabled = i === 0;
      down.disabled = i === segs.length - 1;
      up.addEventListener('click', function () { move(i, -1); });
      down.addEventListener('click', function () { move(i, 1); });
      var save = el('button', { type: 'button', class: 'btn btn-small btn-primary', text: 'حفظ' });
      var del = el('button', { type: 'button', class: 'btn btn-small btn-danger', text: 'حذف' });
      save.addEventListener('click', function () {
        api('PUT', '/api/admin/segments/' + s.id, {
          label: label.value.trim(), weight: Number(weight.value), active: active.checked,
        }).then(function (d) { segState.segments = d.segments; renderSegments(d.totalWeight); })
          .catch(function (err) { alert(err.message); });
      });
      del.addEventListener('click', function () {
        if (!confirm('حذف الخانة "' + s.label + '"؟')) return;
        api('DELETE', '/api/admin/segments/' + s.id).then(function (d) {
          segState.segments = d.segments; renderSegments(d.totalWeight);
        }).catch(function (err) { alert(err.message); });
      });
      body.appendChild(el('tr', null, [
        el('td', null, [up, down]),
        el('td', null, [label]),
        el('td', null, [weight]),
        el('td', null, [active]),
        el('td', null, [save, el('span', { text: ' ' }), del]),
      ]));
    });

    var line = $('seg-total');
    line.textContent = 'مجموع النسب للخانات الفعّالة: ' + totalWeight + '%';
    line.classList.toggle('warn', totalWeight !== 100);
    if (totalWeight !== 100) line.textContent += ' (يجب أن يكون 100%)';
  }

  function move(index, dir) {
    var segs = segState.segments.slice();
    var j = index + dir;
    if (j < 0 || j >= segs.length) return;
    var tmp = segs[index]; segs[index] = segs[j]; segs[j] = tmp;
    api('POST', '/api/admin/segments/reorder', { ids: segs.map(function (s) { return s.id; }) })
      .then(function (d) { segState.segments = d.segments; renderSegments(d.totalWeight); })
      .catch(function (err) { alert(err.message); });
  }

  $('seg-add').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target;
    $('seg-add-error').hidden = true;
    api('POST', '/api/admin/segments', {
      label: f.label.value.trim(), weight: Number(f.weight.value), active: true,
    }).then(function (d) {
      f.label.value = '';
      f.weight.value = '10';
      segState.segments = d.segments;
      renderSegments(d.totalWeight);
    }).catch(function (err) { $('seg-add-error').textContent = err.message; $('seg-add-error').hidden = false; });
  });

  // ---- settings ----
  function loadSettings() {
    api('GET', '/api/admin/settings').then(function (s) {
      var f = $('settings-form');
      f.instagram_url.value = s.instagram_url || '';
      f.facebook_url.value = s.facebook_url || '';
      f.google_review_url.value = s.google_review_url || '';
    }).catch(function () {});
  }

  $('settings-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target;
    $('settings-error').hidden = true;
    $('settings-ok').hidden = true;
    api('PUT', '/api/admin/settings', {
      instagram_url: f.instagram_url.value.trim(),
      facebook_url: f.facebook_url.value.trim(),
      google_review_url: f.google_review_url.value.trim(),
    }).then(function () { $('settings-ok').hidden = false; })
      .catch(function (err) { $('settings-error').textContent = err.message; $('settings-error').hidden = false; });
  });

  // ---- users ----
  function loadUsers() {
    api('GET', '/api/admin/users').then(function (d) {
      var body = $('users-body');
      body.textContent = '';
      d.users.forEach(function (u) {
        var label = u.username + (u.username === d.currentUser ? ' (أنت)' : '');
        body.appendChild(el('tr', null, [
          el('td', { text: label }),
          el('td', { text: fmtDate(u.created_at) }),
        ]));
      });
    }).catch(function () {});
  }

  $('pw-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target;
    $('pw-error').hidden = true;
    $('pw-ok').hidden = true;
    if (f.next.value !== f.confirm.value) {
      $('pw-error').textContent = 'كلمتا المرور غير متطابقتين';
      $('pw-error').hidden = false;
      return;
    }
    api('POST', '/api/admin/users/me/password', { current: f.current.value, next: f.next.value })
      .then(function () {
        $('pw-ok').textContent = 'تم تغيير كلمة المرور. الرجاء تسجيل الدخول من جديد.';
        $('pw-ok').hidden = false;
        f.reset();
        setTimeout(showLogin, 1500);
      })
      .catch(function (err) {
        if (err.message === 'session') return;
        $('pw-error').textContent = err.message;
        $('pw-error').hidden = false;
      });
  });

  // ---- boot: restore session if cookie still valid ----
  fetch('/api/admin/me', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { if (d) showApp(d.username); else showLogin(); })
    .catch(showLogin);
})();
