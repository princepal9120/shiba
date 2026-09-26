/* AI Coworker Doge Mascot Companion (Inspired by ramx.in) */
(function initDogeMascot() {
  if (typeof window === 'undefined') return;
  if (window.__doge_mascot_initialized) return;
  window.__doge_mascot_initialized = true;

  // Check for reduced motion preference
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Sound effects via Web Audio API
  function playSound(type) {
    try {
      const AudioContext = window.AudioContext || window['webkitAudioContext'];
      if (!AudioContext) return;
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      const now = ctx.currentTime;

      if (type === 'bark' || type === 'pet') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(320, now);
        osc.frequency.exponentialRampToValueAtTime(560, now + 0.1);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        osc.start(now);
        osc.stop(now + 0.15);
      } else if (type === 'wake') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(280, now);
        osc.frequency.exponentialRampToValueAtTime(580, now + 0.18);
        gain.gain.setValueAtTime(0.06, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        osc.start(now);
        osc.stop(now + 0.2);
      } else if (type === 'sleep') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(420, now);
        osc.frequency.exponentialRampToValueAtTime(210, now + 0.3);
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
        osc.start(now);
        osc.stop(now + 0.3);
      }
    } catch {
      // AudioContext might require interaction
    }
  }

  // Floating heart / star particle
  function spawnParticle(x, y, char) {
    const el = document.createElement('div');
    el.textContent = char || ['❤️', '✨', '🐾', '⭐'][Math.floor(Math.random() * 4)];
    el.style.cssText = [
      'position: fixed',
      'left: ' + (x + (Math.random() * 20 - 10)) + 'px',
      'top: ' + (y - 10) + 'px',
      'font-size: 18px',
      'pointer-events: none',
      'z-index: 100000',
      'transition: all 0.75s cubic-bezier(0.16, 1, 0.3, 1)',
      'opacity: 1',
      'transform: translateY(0) scale(1)'
    ].join(';');
    document.body.appendChild(el);

    requestAnimationFrame(() => {
      el.style.transform = 'translateY(-40px) scale(1.35)';
      el.style.opacity = '0';
    });
    setTimeout(() => el.remove(), 800);
  }

  // SVG Template for the Doge Mascot
  const SVG_TEMPLATE = `
<svg id="doge-mascot-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120" width="60" height="45" style="overflow: visible; filter: drop-shadow(0 4px 10px rgba(0,0,0,0.5));">
  <defs>
    <linearGradient id="dogeFurGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#E89B3D"/>
      <stop offset="100%" stop-color="#B86616"/>
    </linearGradient>
    <linearGradient id="dogeGlassGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#72CEF9"/>
      <stop offset="50%" stop-color="#3FA5EB"/>
      <stop offset="100%" stop-color="#1B6DBF"/>
    </linearGradient>
  </defs>

  <g id="doge-scaler" style="transform-origin: 80px 60px; transition: transform 0.15s ease;">
    <!-- SHIBA BODY -->
    <g id="doge-body-group">
      <!-- Tail -->
      <path id="doge-tail-path" d="M 32 60 Q 15 40 28 32 Q 42 35 38 52" fill="#FFE8C7" stroke="#000000" stroke-width="4.5" stroke-linecap="round" style="transform-origin: 35px 55px;"/>

      <!-- Back Leg (Left) -->
      <g id="doge-leg-back-left" style="transform-origin: 48px 70px;">
        <rect x="42" y="66" width="13" height="24" rx="6.5" fill="#D68326" stroke="#000000" stroke-width="3.5"/>
        <ellipse cx="48.5" cy="89" rx="7.5" ry="4.5" fill="#FFFFFF" stroke="#000000" stroke-width="3"/>
      </g>

      <!-- Main Torso -->
      <ellipse id="doge-torso-ellipse" cx="75" cy="62" rx="42" ry="24" fill="url(#dogeFurGrad)" stroke="#000000" stroke-width="5"/>
      <!-- Chest Fluff -->
      <path d="M 85 46 Q 106 58 98 78 Q 78 78 75 62 Z" fill="#FFFFFF" opacity="0.95"/>

      <!-- Front Leg (Right) -->
      <g id="doge-leg-front-right" style="transform-origin: 98px 70px;">
        <rect x="92" y="66" width="13" height="24" rx="6.5" fill="#D68326" stroke="#000000" stroke-width="3.5"/>
        <ellipse cx="98.5" cy="89" rx="7.5" ry="4.5" fill="#FFFFFF" stroke="#000000" stroke-width="3"/>
      </g>

      <!-- HEAD GROUP -->
      <g id="doge-head-group" style="transform-origin: 118px 46px;">
        <!-- Back Ear -->
        <path d="M 98 32 L 90 12 Q 106 14 112 28 Z" fill="#B86616" stroke="#000000" stroke-width="4"/>
        <!-- Front Ear -->
        <path d="M 122 28 L 136 8 Q 146 22 138 36 Z" fill="#E89B3D" stroke="#000000" stroke-width="4"/>
        <path d="M 126 26 L 134 14 Q 140 22 134 32 Z" fill="#FFE8C7"/>

        <!-- Head Base -->
        <circle cx="118" cy="46" r="23" fill="url(#dogeFurGrad)" stroke="#000000" stroke-width="4.5"/>

        <!-- White Muzzle -->
        <ellipse cx="127" cy="52" rx="13" ry="9" fill="#FFFFFF" stroke="#000000" stroke-width="3"/>
        <ellipse cx="133" cy="49" rx="3.5" ry="2.5" fill="#111111"/>

        <!-- Eyes / Sunglasses -->
        <g id="doge-eyes-awake">
          <circle cx="114" cy="43" r="3.5" fill="#000000"/>
          <circle cx="115" cy="42" r="1.2" fill="#FFFFFF"/>
        </g>
        <g id="doge-eye-sleep" style="display: block;">
          <path d="M 110 44 Q 116 50 122 44" fill="none" stroke="#000000" stroke-width="3.5" stroke-linecap="round"/>
        </g>
        <g id="doge-sunglasses" style="display: none;">
          <rect x="106" y="37" width="13" height="11" rx="2.5" fill="url(#dogeGlassGrad)" stroke="#000000" stroke-width="2.5"/>
          <rect x="121" y="37" width="14" height="11" rx="2.5" fill="url(#dogeGlassGrad)" stroke="#000000" stroke-width="2.5"/>
          <line x1="118" y1="41" x2="122" y2="41" stroke="#000000" stroke-width="2.5"/>
          <line x1="108" y1="39" x2="110" y2="45" stroke="#FFFFFF" stroke-width="1.5"/>
          <line x1="123" y1="39" x2="125" y2="45" stroke="#FFFFFF" stroke-width="1.5"/>
        </g>
      </g>
    </g>

    <!-- ZZZ Particle Icons -->
    <g id="doge-zzz-group">
      <text x="135" y="24" font-family="'DM Mono', monospace" font-size="14" font-weight="bold" fill="#2DD4BF" opacity="0.9">z</text>
      <text x="145" y="14" font-family="'DM Mono', monospace" font-size="18" font-weight="bold" fill="#2DD4BF" opacity="0.9">Z</text>
    </g>

    <!-- Exclamation Alert -->
    <g id="doge-alert-icon" style="display: none;">
      <circle cx="140" cy="8" r="9" fill="#0B9F95" stroke="#FFFFFF" stroke-width="2"/>
      <text x="137" y="13" font-family="'DM Mono', monospace" font-size="13" font-weight="bold" fill="#FFFFFF">!</text>
    </g>
  </g>
</svg>
`;

  // Create Container
  const mascotContainer = document.createElement('div');
  mascotContainer.id = 'active-doge-mascot';
  mascotContainer.innerHTML = SVG_TEMPLATE;
  mascotContainer.style.cssText = [
    'position: fixed',
    'width: 60px',
    'height: 45px',
    'z-index: 99999',
    'cursor: grab',
    'user-select: none',
    'pointer-events: auto',
    'transform: translate(-50%, -50%)',
    'transition: filter 0.2s ease',
    'will-change: left, top, transform'
  ].join(';');

  // State Variables
  let posX = 0;
  let posY = 0;
  let mouseX = 0;
  let mouseY = 0;
  let isSleeping = true;
    let isDragging = false;
  let facingRight = true;
  let idleTime = 0;
  let animTick = 0;
  let petCount = parseInt(localStorage.getItem('doge_pet_count') || '0', 10);

  // Perch Target (on top of Install button)
  function getPerchPosition() {
    const btn = document.querySelector('a[href="/docs/getting-started"], [data-oneko-nap="true"]');
    if (btn) {
      const rect = btn.getBoundingClientRect();
      return {
        x: rect.right - 28,
        y: rect.top - 10
      };
    }
    return {
      x: window.innerWidth - 60,
      y: 80
    };
  }

  // Set Mascot SVG visual mode: 'sleeping', 'awake', 'running', 'alert'
  function setVisualMode(mode) {
    const eyeSleep = mascotContainer.querySelector('#doge-eye-sleep');
    const eyesAwake = mascotContainer.querySelector('#doge-eyes-awake');
    const sunglasses = mascotContainer.querySelector('#doge-sunglasses');
    const zzz = mascotContainer.querySelector('#doge-zzz-group');
    const alertIcon = mascotContainer.querySelector('#doge-alert-icon');
    const tail = mascotContainer.querySelector('#doge-tail-path');
    const legBack = mascotContainer.querySelector('#doge-leg-back-left');
    const legFront = mascotContainer.querySelector('#doge-leg-front-right');
    const head = mascotContainer.querySelector('#doge-head-group');

    if (!eyeSleep) return;

    if (mode === 'sleeping') {
      eyeSleep.style.display = 'block';
      if (eyesAwake) eyesAwake.style.display = 'none';
      if (sunglasses) sunglasses.style.display = 'none';
      if (zzz) zzz.style.display = 'block';
      if (alertIcon) alertIcon.style.display = 'none';
      if (legBack) legBack.style.transform = 'rotate(0deg)';
      if (legFront) legFront.style.transform = 'rotate(0deg)';
      if (head) head.style.transform = 'translateY(2px) rotate(4deg)';
      if (tail) tail.style.transform = 'rotate(0deg)';
    } else if (mode === 'alert') {
      eyeSleep.style.display = 'none';
      if (eyesAwake) eyesAwake.style.display = 'none';
      if (sunglasses) sunglasses.style.display = 'block';
      if (zzz) zzz.style.display = 'none';
      if (alertIcon) alertIcon.style.display = 'block';
      if (head) head.style.transform = 'translateY(-4px) rotate(-6deg)';
    } else if (mode === 'running') {
      eyeSleep.style.display = 'none';
      if (eyesAwake) eyesAwake.style.display = 'none';
      if (sunglasses) sunglasses.style.display = 'block';
      if (zzz) zzz.style.display = 'none';
      if (alertIcon) alertIcon.style.display = 'none';
    } else { // idle / awake
      eyeSleep.style.display = 'none';
      if (eyesAwake) eyesAwake.style.display = 'block';
      if (sunglasses) sunglasses.style.display = 'block';
      if (zzz) zzz.style.display = 'none';
      if (alertIcon) alertIcon.style.display = 'none';
      if (legBack) legBack.style.transform = 'rotate(0deg)';
      if (legFront) legFront.style.transform = 'rotate(0deg)';
      if (head) head.style.transform = 'rotate(0deg)';
    }
  }

  // Pet action
  function onPet() {
    petCount++;
    localStorage.setItem('doge_pet_count', petCount.toString());
    playSound('pet');
    spawnParticle(posX, posY, '❤️');
    idleTime = 0;

    // Wake up if sleeping
    if (isSleeping) {
      isSleeping = false;
      setVisualMode('alert');
      setTimeout(() => setVisualMode('running'), 250);
    }

    // Little happy leap
    const scaler = mascotContainer.querySelector('#doge-scaler');
    if (scaler) {
      scaler.style.transform = (facingRight ? 'scaleX(1)' : 'scaleX(-1)') + ' translateY(-12px) scale(1.15)';
      setTimeout(() => {
        scaler.style.transform = (facingRight ? 'scaleX(1)' : 'scaleX(-1)') + ' translateY(0) scale(1)';
      }, 200);
    }
  }

  mascotContainer.addEventListener('click', onPet);

  // Dragging support
  mascotContainer.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    mascotContainer.style.cursor = 'grabbing';
    const startX = e.clientX;
    const startY = e.clientY;
    const initX = posX;
    const initY = posY;

    const onMouseMove = (moveEvt) => {
      posX = initX + (moveEvt.clientX - startX);
      posY = initY + (moveEvt.clientY - startY);
      mascotContainer.style.left = posX + 'px';
      mascotContainer.style.top = posY + 'px';
    };

    const onMouseUp = () => {
      isDragging = false;
      mascotContainer.style.cursor = 'grab';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      idleTime = 0;
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  });

  // Track cursor movement across window
  let lastMoveTime = Date.now();
  window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    lastMoveTime = Date.now();

    // If sleeping on perch and user moves mouse, wake up!
    if (isSleeping) {
      isSleeping = false;
      playSound('wake');
      setVisualMode('alert');
      setTimeout(() => setVisualMode('running'), 200);
    }
  });

  // Main Animation Loop
  const speed = 10;
  function update() {
    animTick++;

    if (isDragging) {
      requestAnimationFrame(update);
      return;
    }

    // If user idle for > 10 seconds, go back to sleep on button perch!
    const timeSinceMove = Date.now() - lastMoveTime;
    if (timeSinceMove > 10000 && !isSleeping) {
      const perch = getPerchPosition();
      const dx = posX - perch.x;
      const dy = posY - perch.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > 15) {
        // Run back to perch
        const angle = Math.atan2(dy, dx);
        posX -= Math.cos(angle) * speed;
        posY -= Math.sin(angle) * speed;
        facingRight = dx < 0;
        setVisualMode('running');
        animateRunningLimbs();
      } else {
        // Arrived at perch, go to sleep!
        posX = perch.x;
        posY = perch.y;
        isSleeping = true;
        setVisualMode('sleeping');
        playSound('sleep');
      }

      mascotContainer.style.left = posX + 'px';
      mascotContainer.style.top = posY + 'px';
      updateFacing();
      requestAnimationFrame(update);
      return;
    }

    if (isSleeping) {
      // Stay on perch
      const perch = getPerchPosition();
      posX = perch.x;
      posY = perch.y;
      mascotContainer.style.left = posX + 'px';
      mascotContainer.style.top = posY + 'px';

      // Breathing effect
      const torso = mascotContainer.querySelector('#doge-torso-ellipse');
      if (torso) {
        const breathe = Math.sin(animTick * 0.08) * 1.5;
        torso.setAttribute('ry', (24 + breathe).toString());
      }
      requestAnimationFrame(update);
      return;
    }

    // Awake: Chasing Cursor!
    // Destination: slightly offset from cursor so it doesn't block clicks
    const targetX = mouseX + (facingRight ? -28 : 28);
    const targetY = mouseY + 14;

    const diffX = posX - targetX;
    const diffY = posY - targetY;
    const dist = Math.sqrt(diffX * diffX + diffY * diffY);

    if (dist > 25) {
      // Running to cursor
            const angle = Math.atan2(diffY, diffX);
      posX -= Math.cos(angle) * Math.min(speed, dist);
      posY -= Math.sin(angle) * Math.min(speed, dist);
      facingRight = diffX < 0;

      setVisualMode('running');
      animateRunningLimbs();
      idleTime = 0;
    } else {
      // Arrived at cursor -> Idle
            idleTime++;
      setVisualMode('awake');

      // Idle animations: gentle tail wag & slight breathing
      const tail = mascotContainer.querySelector('#doge-tail-path');
      if (tail) {
        tail.style.transform = 'rotate(' + (Math.sin(animTick * 0.15) * 12) + 'deg)';
      }
      const legBack = mascotContainer.querySelector('#doge-leg-back-left');
      const legFront = mascotContainer.querySelector('#doge-leg-front-right');
      if (legBack) legBack.style.transform = 'rotate(0deg)';
      if (legFront) legFront.style.transform = 'rotate(0deg)';
    }

    mascotContainer.style.left = posX + 'px';
    mascotContainer.style.top = posY + 'px';
    updateFacing();

    requestAnimationFrame(update);
  }

  function animateRunningLimbs() {
    const legBack = mascotContainer.querySelector('#doge-leg-back-left');
    const legFront = mascotContainer.querySelector('#doge-leg-front-right');
    const tail = mascotContainer.querySelector('#doge-tail-path');
    const bodyGroup = mascotContainer.querySelector('#doge-body-group');

    const swing = Math.sin(animTick * 0.45) * 28;
    if (legBack) legBack.style.transform = 'rotate(' + swing + 'deg)';
    if (legFront) legFront.style.transform = 'rotate(' + (-swing) + 'deg)';
    if (tail) tail.style.transform = 'rotate(' + (Math.sin(animTick * 0.6) * 22) + 'deg)';
    if (bodyGroup) bodyGroup.style.transform = 'translateY(' + (Math.abs(Math.sin(animTick * 0.45)) * -4) + 'px)';
  }

  function updateFacing() {
    const scaler = mascotContainer.querySelector('#doge-scaler');
    if (scaler) {
      scaler.style.transform = facingRight ? 'scaleX(1)' : 'scaleX(-1)';
    }
  }

  // Mount to DOM
  function start() {
    if (prefersReducedMotion) {
      return; // Restrained behavior: do not spawn wandering mascot when reduced-motion is requested
    }

    const initPerch = getPerchPosition();
    posX = initPerch.x;
    posY = initPerch.y;
    mascotContainer.style.left = posX + 'px';
    mascotContainer.style.top = posY + 'px';

    setVisualMode('sleeping');

    // Hide the static SVG on top of the button so only this interactive mascot is visible
    const staticDogeOnButton = document.querySelector('[data-mascot-static="true"]');
    if (staticDogeOnButton) {
      staticDogeOnButton.style.display = 'none';
    }

    document.body.appendChild(mascotContainer);
    requestAnimationFrame(update);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
