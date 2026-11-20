/* Spin wheel renderer. Black-and-white only, per the Rassif brandbook greyscale rules.
 * The outcome is decided by the server. This file only animates to the index it is given. */
(function () {
  'use strict';

  var INK = '#191919';
  var PAPER = '#FFFFFF';
  var GREY = '#6B6B6B';

  function Wheel(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.segments = [];
    this.rotation = 0; // degrees
    this.spinning = false;
    this._resize();
    var self = this;
    window.addEventListener('resize', function () { self._resize(); self.draw(); });
  }

  Wheel.prototype._resize = function () {
    var cssSize = Math.min(this.canvas.parentElement.clientWidth || 360, 420);
    var dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = cssSize + 'px';
    this.canvas.style.height = cssSize + 'px';
    this.canvas.width = Math.round(cssSize * dpr);
    this.canvas.height = Math.round(cssSize * dpr);
    this.dpr = dpr;
    this.size = cssSize;
  };

  Wheel.prototype.setSegments = function (segments) {
    this.segments = segments.slice();
    this.rotation = 0;
    this.draw();
  };

  Wheel.prototype._colorFor = function (i, n) {
    // Alternate black / white. An odd count gets a mid grey on the last field so it never touches the first.
    if (n % 2 === 1 && i === n - 1) return GREY;
    return i % 2 === 0 ? INK : PAPER;
  };

  Wheel.prototype.draw = function () {
    var ctx = this.ctx;
    var s = this.size;
    var n = this.segments.length;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, s, s);

    var cx = s / 2, cy = s / 2, r = s / 2 - 8;
    if (n === 0) {
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = PAPER; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = INK; ctx.stroke();
      return;
    }

    var slice = (Math.PI * 2) / n;
    var base = (-Math.PI / 2) + this.rotation * Math.PI / 180;

    for (var i = 0; i < n; i++) {
      var start = base + i * slice;
      var end = start + slice;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, start, end);
      ctx.closePath();
      ctx.fillStyle = this._colorFor(i, n);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = INK;
      ctx.stroke();
    }

    // Labels
    for (var j = 0; j < n; j++) {
      var a0 = base + j * slice;
      var mid = a0 + slice / 2;
      var fill = this._colorFor(j, n);
      var textColor = fill === PAPER ? INK : PAPER;
      // Labels on the lower/left half would read upside down, so flip them by 180 degrees
      // and anchor them to the outer edge instead.
      var norm = ((mid % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      var flip = norm > Math.PI / 2 && norm < (Math.PI * 3) / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(flip ? mid + Math.PI : mid);
      ctx.textBaseline = 'middle';
      ctx.fillStyle = textColor;
      var fontSize = Math.max(12, Math.min(22, Math.round(r * 0.075)));
      ctx.font = '700 ' + fontSize + 'px Rubik, Montserrat, Arial, sans-serif';
      var maxWidth = r * 0.72;
      var label = fitText(ctx, this.segments[j].label, maxWidth);
      if (flip) {
        ctx.textAlign = 'left';
        ctx.fillText(label, -(r - 16), 0);
      } else {
        ctx.textAlign = 'right';
        ctx.fillText(label, r - 16, 0);
      }
      ctx.restore();
    }

    // Hub
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.13, 0, Math.PI * 2);
    ctx.fillStyle = PAPER; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = INK; ctx.stroke();
  };

  function fitText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    var t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
    return t + '…';
  }

  // Rotate so that the centre of segment `index` sits under the pointer at the top.
  // Adds several full turns, and a random offset inside the slice so the stop looks natural.
  Wheel.prototype.spinTo = function (index, durationMs) {
    var self = this;
    var n = this.segments.length;
    if (n === 0 || index < 0 || index >= n || this.spinning) return Promise.resolve();
    this.spinning = true;

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

    return new Promise(function (resolve) {
      function ease(t) { return 1 - Math.pow(1 - t, 4); }
      function frame(ts) {
        if (startTs === null) startTs = ts;
        var t = Math.min(1, (ts - startTs) / duration);
        self.rotation = from + (finalRotation - from) * ease(t);
        self.draw();
        if (t < 1) {
          requestAnimationFrame(frame);
        } else {
          self.rotation = finalRotation;
          self.draw();
          self.spinning = false;
          resolve();
        }
      }
      requestAnimationFrame(frame);
    });
  };

  window.SpinWheel = Wheel;
})();
