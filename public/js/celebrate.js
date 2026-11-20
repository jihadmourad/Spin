/* Win celebration: layered fireworks bursts and a confetti rain on a full-screen canvas.
 * Brand colours only. Skipped when the user prefers reduced motion. */
(function () {
  'use strict';

  var COLORS = ['#FFD300', '#FFE45C', '#191919', '#FFFFFF'];

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function celebrate(options) {
    options = options || {};
    if (reducedMotion()) return { stop: function () {} };

    var canvas = document.createElement('canvas');
    canvas.className = 'celebrate-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    var W = window.innerWidth, H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';

    var particles = [];
    var rockets = [];
    var duration = options.duration || 4200;
    var start = null;
    var lastBurst = 0;
    var stopped = false;

    function burst(x, y, count) {
      for (var i = 0; i < count; i++) {
        var angle = (Math.PI * 2 * i) / count + Math.random() * 0.2;
        var speed = 2 + Math.random() * 5.5;
        particles.push({
          x: x, y: y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 1,
          decay: 0.012 + Math.random() * 0.012,
          size: 2 + Math.random() * 2.5,
          color: COLORS[(Math.random() * COLORS.length) | 0],
          trail: [],
        });
      }
    }

    function confettiPiece() {
      return {
        x: Math.random() * W,
        y: -20 - Math.random() * H * 0.3,
        vx: (Math.random() - 0.5) * 2,
        vy: 2 + Math.random() * 3,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.25,
        w: 6 + Math.random() * 6,
        h: 4 + Math.random() * 4,
        color: COLORS[(Math.random() * COLORS.length) | 0],
        sway: Math.random() * Math.PI * 2,
      };
    }

    var confetti = [];
    for (var c = 0; c < 140; c++) confetti.push(confettiPiece());

    function frame(ts) {
      if (stopped) return;
      if (start === null) start = ts;
      var elapsed = ts - start;

      // Launch a rocket every ~380ms during the first part of the show, then let it fade.
      if (elapsed < duration * 0.75 && ts - lastBurst > 380) {
        lastBurst = ts;
        rockets.push({ x: Math.random() * W * 0.8 + W * 0.1, y: H, tx: 0, ty: H * (0.18 + Math.random() * 0.35), v: 9 + Math.random() * 3 });
      }
      rockets.forEach(function (r) {
        r.y -= r.v;
        if (r.y <= r.ty) {
          burst(r.x, r.y, 46 + ((Math.random() * 20) | 0));
          r.done = true;
        }
      });
      rockets = rockets.filter(function (r) { return !r.done; });

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // Confetti rain
      confetti.forEach(function (p) {
        p.sway += 0.04;
        p.x += p.vx + Math.sin(p.sway) * 0.8;
        p.y += p.vy;
        p.rot += p.vr;
        if (p.y > H + 20) {
          Object.assign(p, confettiPiece(), { y: -20 });
        }
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.strokeStyle = '#191919';
        ctx.lineWidth = 1;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.strokeRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      });

      // Firework sparks with short trails
      particles.forEach(function (p) {
        p.trail.push({ x: p.x, y: p.y });
        if (p.trail.length > 6) p.trail.shift();
        p.vy += 0.09;   // gravity
        p.vx *= 0.985;  // air drag
        p.vy *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.life -= p.decay;
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.color;
        p.trail.forEach(function (t, i) {
          ctx.globalAlpha = Math.max(0, p.life) * (i / p.trail.length) * 0.6;
          ctx.beginPath();
          ctx.arc(t.x, t.y, p.size * (i / p.trail.length), 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
      particles = particles.filter(function (p) { return p.life > 0; });

      if (elapsed < duration || particles.length > 0 || rockets.length > 0) {
        requestAnimationFrame(frame);
      } else {
        canvas.remove();
      }
    }

    requestAnimationFrame(frame);
    // A first burst right away so the win feels immediate.
    burst(W / 2, H * 0.35, 70);

    return {
      stop: function () {
        stopped = true;
        canvas.remove();
      },
    };
  }

  window.Celebrate = { start: celebrate };
})();
