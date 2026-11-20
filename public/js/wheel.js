/* Spin wheel renderer. Brand palette: Yellow #FFD300, Black #191919, White #FFFFFF.
 * The outcome is decided by the server. This file only animates to the index it is given. */
(function () {
  'use strict';

  var YELLOW = '#FFD300';
  var INK = '#191919';
  var PAPER = '#FFFFFF';
  var GREY = '#8A8A8A';
  var CYCLE = [YELLOW, INK, PAPER, GREY];

  // Colours for n fields. Greedy: each field takes the first colour that differs from its
  // neighbour, and the last field must also differ from the first, so the wrap-around is clean.
  function colorsFor(n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      for (var k = 0; k < CYCLE.length; k++) {
        var c = CYCLE[k];
        var okPrev = i === 0 || out[i - 1] !== c;
        var okWrap = i !== n - 1 || n < 2 || out[0] !== c;
        if (okPrev && okWrap) { out.push(c); break; }
      }
      if (out.length <= i) out.push(CYCLE[i % CYCLE.length]);
    }
    return out;
  }

  function Wheel(canvas, options) {
    options = options || {};
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.segments = [];
    this.colors = [];
    this.rotation = 0; // degrees
    this.spinning = false;
    this.winner = null;
    this.onTick = options.onTick || function () {};
    this._lastTick = null;
    this._resize();
    var self = this;
    window.addEventListener('resize', function () { self._resize(); self.draw(); });
  }

  Wheel.prototype._resize = function () {
    var cssSize = Math.min(this.canvas.parentElement.clientWidth || 360, 440);
    var dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = cssSize + 'px';
    this.canvas.style.height = cssSize + 'px';
    this.canvas.width = Math.round(cssSize * dpr);
    this.canvas.height = Math.round(cssSize * dpr);
    this.dpr = dpr;
    this.size = cssSize;
  };

  // Keeps the current rotation, so changing the language only redraws the labels.
  Wheel.prototype.setSegments = function (segments) {
    this.segments = segments.slice();
    this.colors = colorsFor(this.segments.length);
    if (this.winner !== null && this.winner >= this.segments.length) this.winner = null;
    this.draw();
  };

  Wheel.prototype.draw = function () {
    var ctx = this.ctx;
    var s = this.size;
    var n = this.segments.length;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, s, s);

    var cx = s / 2, cy = s / 2, r = s / 2 - 10;
    if (n === 0) {
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = PAPER; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = INK; ctx.stroke();
      return;
    }

    var slice = (Math.PI * 2) / n;
    var base = (-Math.PI / 2) + this.rotation * Math.PI / 180;

    // Outer rim
    ctx.beginPath(); ctx.arc(cx, cy, r + 6, 0, Math.PI * 2);
    ctx.fillStyle = INK; ctx.fill();

    for (var i = 0; i < n; i++) {
      var start = base + i * slice;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, start, start + slice);
      ctx.closePath();
      ctx.fillStyle = this.colors[i];
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = INK;
      ctx.stroke();
    }

    // Labels
    var fontSize = Math.max(13, Math.min(24, Math.round(r * (n > 4 ? 0.07 : 0.085))));
    for (var j = 0; j < n; j++) {
      var mid = base + j * slice + slice / 2;
      var textColor = this.colors[j] === INK ? PAPER : INK;
      // Labels on the lower/left half would read upside down, so flip them by 180 degrees
      // and anchor them to the outer edge instead.
      var norm = ((mid % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      var flip = norm > Math.PI / 2 && norm < (Math.PI * 3) / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(flip ? mid + Math.PI : mid);
      ctx.textBaseline = 'middle';
      ctx.fillStyle = textColor;
      ctx.font = '700 ' + fontSize + 'px Rubik, Montserrat, Arial, sans-serif';
      var label = fitText(ctx, this.segments[j].label, r * 0.7);
      if (flip) {
        ctx.textAlign = 'left';
        ctx.fillText(label, -(r - 18), 0);
      } else {
        ctx.textAlign = 'right';
        ctx.fillText(label, r - 18, 0);
      }
      ctx.restore();
    }

    // Winning field highlight (drawn after a spin finishes)
    if (this.winner !== null && this.winner < n) {
      var ws = base + this.winner * slice;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, ws, ws + slice);
      ctx.closePath();
      ctx.lineWidth = 6;
      ctx.strokeStyle = YELLOW;
      ctx.stroke();
    }

    // Hub
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.15, 0, Math.PI * 2);
    ctx.fillStyle = YELLOW; ctx.fill();
    ctx.lineWidth = 4; ctx.strokeStyle = INK; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.05, 0, Math.PI * 2);
    ctx.fillStyle = INK; ctx.fill();
  };

  function fitText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    var t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
    return t + '…';
  }

  // Index of the field currently under the pointer (top of the wheel).
  Wheel.prototype._indexUnderPointer = function () {
    var n = this.segments.length;
    if (!n) return -1;
    var slice = 360 / n;
    var rel = ((-this.rotation) % 360 + 360) % 360;
    return Math.floor(rel / slice) % n;
  };

  // Rotate so that the centre of field `index` sits under the pointer at the top.
  // Several full turns plus a random offset inside the field, so each stop looks natural.
  Wheel.prototype.spinTo = function (index, durationMs) {
    var self = this;
    var n = this.segments.length;
    if (n === 0 || index < 0 || index >= n || this.spinning) return Promise.resolve();
    this.spinning = true;
    this.winner = null;

    var slice = 360 / n;
    var jitter = (Math.random() - 0.5) * slice * 0.6;
    var targetMod = ((-(index + 0.5) * slice) % 360 + 360) % 360 + jitter;
    var current = this.rotation;
    var currentMod = ((current % 360) + 360) % 360;
    var delta = ((targetMod - currentMod) % 360 + 360) % 360;
    var finalRotation = current + delta + 360 * 6;
    var from = current;
    var duration = durationMs || 5200;
    var startTs = null;
    this._lastTick = this._indexUnderPointer();

    return new Promise(function (resolve) {
      // Quartic ease-out. No overshoot, so the wheel stops exactly on the chosen field.
      function ease(t) { return 1 - Math.pow(1 - t, 4); }
      function frame(ts) {
        if (startTs === null) startTs = ts;
        var t = Math.min(1, (ts - startTs) / duration);
        self.rotation = from + (finalRotation - from) * ease(t);
        var under = self._indexUnderPointer();
        if (under !== self._lastTick) {
          self._lastTick = under;
          self.onTick();
        }
        self.draw();
        if (t < 1) {
          requestAnimationFrame(frame);
        } else {
          self.rotation = finalRotation;
          self.winner = index;
          self.spinning = false;
          self.draw();
          resolve();
        }
      }
      requestAnimationFrame(frame);
    });
  };

  window.SpinWheel = Wheel;
})();
