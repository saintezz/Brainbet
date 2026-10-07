/* Presentation only. Controllers own angles, weights and winners. */
(() => {
  'use strict';
  const palette = ['#72f3cc', '#82cfff', '#c4a5ff', '#ffa9c4', '#ffe0a3', '#96d6ff', '#b2edab', '#c7b6ff'];
  const multipliers = {2: '#72f3cc', 3: '#82cfff', 10: '#b39bff', 15: '#ffa9c4', 20: '#ffe0a3', 40: '#ff8799'};
  function drawDial(canvasId, segments, rotation = 0, winner = -1, label = 'ULTRA') {
    const canvas = document.getElementById(canvasId);
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const radius = Math.min(cx, cy) - 12, inner = radius * .49;
    if (radius < 10) return;
    const total = segments.reduce((sum, part) => sum + Math.max(0, Number(part.weight) || 0), 0);
    if (!total) return;
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.beginPath(); ctx.arc(cx, cy, radius + 10, 0, Math.PI * 2);
    ctx.fillStyle = '#0c192c'; ctx.fill();
    ctx.strokeStyle = '#35546d'; ctx.lineWidth = 1; ctx.stroke();
    let angle = rotation;
    segments.forEach((part, index) => {
      const slice = Math.max(0, Number(part.weight) || 0) / total * Math.PI * 2;
      if (!slice) return;
      const gap = Math.min(.018, slice * .15);
      const start = angle + gap, end = angle + slice - gap, mid = angle + slice / 2;
      const color = part.color || palette[index % palette.length];
      const fill = ctx.createRadialGradient(cx, cy, inner, cx, cy, radius);
      fill.addColorStop(0, '#12243b'); fill.addColorStop(.8, color + '60'); fill.addColorStop(1, color + 'a0');
      ctx.beginPath(); ctx.arc(cx, cy, radius - 4, start, end);
      ctx.arc(cx, cy, inner, end, start, true); ctx.closePath();
      ctx.fillStyle = fill; ctx.fill();
      ctx.strokeStyle = index === winner ? '#edfff7' : color + '60';
      ctx.lineWidth = index === winner ? 3 : 1; ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, radius - 5, start, end);
      ctx.strokeStyle = color; ctx.lineWidth = index === winner ? 5 : 2; ctx.stroke();
      if (slice > .17) {
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(mid);
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = `700 ${Math.max(10, radius * .075)}px "Exo 2", sans-serif`;
        ctx.fillStyle = '#f4fbff'; ctx.translate(radius * .74, 0); ctx.rotate(-mid);
        ctx.fillText(String(part.label || ''), 0, 0); ctx.restore();
      }
      angle += slice;
    });
    for (let i = 0; i < 60; i++) {
      const a = i * Math.PI / 30, big = i % 5 === 0;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (radius + 3), cy + Math.sin(a) * (radius + 3));
      ctx.lineTo(cx + Math.cos(a) * (radius + (big ? 8 : 5)), cy + Math.sin(a) * (radius + (big ? 8 : 5)));
      ctx.strokeStyle = big ? '#a4c8dd' : '#385570'; ctx.lineWidth = 1; ctx.stroke();
    }
    const hub = ctx.createRadialGradient(cx, cy - inner * .3, 0, cx, cy, inner);
    hub.addColorStop(0, '#203b51'); hub.addColorStop(1, '#091321');
    ctx.beginPath(); ctx.arc(cx, cy, inner - 5, 0, Math.PI * 2);
    ctx.fillStyle = hub; ctx.fill(); ctx.strokeStyle = '#496b80'; ctx.lineWidth = 1; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, inner - 13, -.8, Math.PI * 1.2);
    ctx.strokeStyle = '#72f3cc66'; ctx.stroke();
    ctx.fillStyle = '#c5fff0'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `800 ${Math.max(13, radius * .15)}px "Exo 2", sans-serif`;
    ctx.fillText(label, cx, cy - 3);
    ctx.fillStyle = '#83a4bc'; ctx.font = `600 ${Math.max(7, radius * .05)}px "Exo 2", sans-serif`;
    ctx.fillText('B R A I N B E T', cx, cy + radius * .15);
    ctx.beginPath(); ctx.moveTo(cx, 23); ctx.lineTo(cx - 8, 5); ctx.lineTo(cx, 1); ctx.lineTo(cx + 8, 5); ctx.closePath();
    ctx.fillStyle = '#c7ffeb'; ctx.shadowColor = '#72f3cc'; ctx.shadowBlur = 8; ctx.fill();
    ctx.restore();
  }
  window.BBUltraVisuals = Object.freeze({drawDial, palette: Object.freeze(palette), multipliers: Object.freeze(multipliers)});
})();
