// Video Outpainting — project page interactions
(function () {
  "use strict";

  /* ===============================================================
   * MEDIA CONFIG — single source of truth.
   *
   * Each clip is one outpainted video, media/<id>.mp4, with a poster at
   * media/posters/<id>.jpg (both made by scripts/prepare_media.sh).
   * `src` and `out` are the source and output frame sizes. The source
   * frame is assumed to be fit and centered on the output canvas; set
   * `box` ([x, y, w, h] as fractions of the canvas) for one that isn't.
   * The source region passes through the outpainter untouched, so
   * masking everything outside it shows exactly the original,
   * letterboxed; that's the "Original" view.
   * =============================================================== */
  var CLIPS = {
    pres_9_16:          { title: "Presenter",   src: [1080, 1920], out: [1920, 1088] },
    demo_9_16:          { title: "Cooking",     src: [1080, 1920], out: [1920, 1088] },
    office_9_16:        { title: "Aerial",      src: [1080, 1920], out: [1920, 1088] },
    outdoors_9_16:      { title: "Garden",      src: [720, 1280],  out: [1280, 768], box: [0.306, 0, 0.3375, 1] },
    ocean_9_16:         { title: "Waterfall",   src: [720, 1280],  out: [1280, 768] },
    tutorial_9_16:      { title: "Flowers",     src: [1080, 1920], out: [1920, 1088] },
    talking_woman_16_9: { title: "Interview",   src: [1920, 1080], out: [1088, 1920] },
    presentation_16_9:  { title: "Keynote",     src: [1920, 1080], out: [1088, 1920] },
    long_hair_guy_16_9: { title: "Desk",        src: [1920, 1080], out: [1088, 1920] },
    car_guy_16_9:       { title: "Car",         src: [1920, 1080], out: [1088, 1920] },
    tennis_16_9:        { title: "Tennis",      src: [1920, 1080], out: [1088, 1920] },
    ocean_16_9:         { title: "Ocean",       src: [1920, 1080], out: [1088, 1920] }
  };

  var MEDIA = {
    hero: "pres_9_16",
    groups: [
      { label: "Portrait → landscape", ids: ["demo_9_16", "office_9_16", "outdoors_9_16", "ocean_9_16", "tutorial_9_16"] },
      { label: "Landscape → portrait", ids: ["talking_woman_16_9", "presentation_16_9", "long_hair_guy_16_9", "car_guy_16_9", "tennis_16_9", "ocean_16_9"] }
    ]
  };

  // Videos come from the GCS bucket once deployed; locally, from media/.
  var MEDIA_BASE = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? ""
    : "https://storage.googleapis.com/lyrebird-research-web-demos/video-outpainting/";
  function videoUrl(id) { return MEDIA_BASE ? MEDIA_BASE + id + ".mp4" : "media/" + id + ".mp4"; }
  function posterUrl(id) { return "media/posters/" + id + ".jpg"; }

  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function sourceBox(clip) {
    if (clip.box) return clip.box;
    var fit = Math.min(clip.out[0] / clip.src[0], clip.out[1] / clip.src[1]);
    var w = clip.src[0] * fit / clip.out[0];
    var h = clip.src[1] * fit / clip.out[1];
    return [(1 - w) / 2, (1 - h) / 2, w, h];
  }
  var PLAY_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
  var ICON_VOL_ON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4.03v8.05A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z"/></svg>';
  var ICON_VOL_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm18.29-.71L19.88 6.88 17 9.76l-2.88-2.88-1.41 1.41L15.59 11l-2.88 2.88 1.41 1.41L17 12.41l2.88 2.88 1.41-1.41L18.41 11l2.88-2.71z"/></svg>';
  var ICON_FS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';

  /* ---------------------------------------------------------------
   * "Original" overlay: the editor's outpaint-generating look, ported
   * from OutpaintShaderOverlay. Everything outside the source frame is
   * flickering grain tinted by the frame's own edge colors, with
   * particles drifting outward from the edges. Switching to
   * "Outpainted" dissolves it from the frame outward.
   * ------------------------------------------------------------- */
  var COLOR_SAMPLE_SIZE = 96;
  var COLOR_SAMPLE_MS = 100;
  /** Time constant the displayed colors ease toward each new sample with, so playback doesn't jump. */
  var COLOR_SMOOTH_MS = 250;
  var COLOR_FADE_MS = 180;
  var FALLBACK_COLOR = 100;
  var MAX_PARTICLES = 1400;
  var MIN_PARTICLES = 60;
  var PARTICLE_STRIDE = 7;
  var IDLE_FRAME_MS = 1000 / 30 - 2;
  var REVEAL_MS = 900;
  var HIDE_MS = 450;
  var INTRO_DELAY_MS = 1100;
  /** How long an autoplaying clip's reveal waits for playback before going ahead anyway. */
  var AUTOPLAY_WAIT_MS = 3000;

  var QUAD_VS = [
    "attribute vec2 a_position;",
    "varying vec2 v_uv;",
    "void main() {",
    "  v_uv = vec2(a_position.x * 0.5 + 0.5, 0.5 - a_position.y * 0.5);",
    "  gl_Position = vec4(a_position, 0.0, 1.0);",
    "}"
  ].join("\n");

  var NOISE_FS = [
    "precision highp float;",
    "varying vec2 v_uv;",
    "uniform vec2 u_size;",
    "uniform float u_scale;",
    "uniform vec4 u_box;",
    "uniform float u_time;",
    "uniform sampler2D u_colors;",
    "uniform float u_colorMix;",
    "uniform float u_reveal;",
    "float hash(vec3 p) {",
    "  p = fract(p * vec3(0.1031, 0.1030, 0.0973));",
    "  p += dot(p, p.yxz + 33.33);",
    "  return fract((p.x + p.y) * p.z);",
    "}",
    "float field(vec2 px, float seed, float rate) {",
    "  float phase = hash(vec3(px, seed + 101.0));",
    "  float epoch = floor(u_time * rate + phase);",
    "  return hash(vec3(px, seed + epoch * 7.13));",
    "}",
    "void main() {",
    "  vec2 p = v_uv * u_size;",
    "  vec2 b0 = u_box.xy * u_size;",
    "  vec2 b1 = (u_box.xy + u_box.zw) * u_size;",
    "  vec2 media = (p - b0) / (b1 - b0);",
    "  if (all(greaterThanEqual(media, vec2(0.0))) && all(lessThanEqual(media, vec2(1.0)))) discard;",
    "  vec2 px = floor(p * u_scale);",
    "  float dist = length(max(max(b0 - p, p - b1), 0.0));",
    "  float extent = max(max(b0.x, u_size.x - b1.x), max(b0.y, u_size.y - b1.y));",
    // dissolve order: mostly random, biased so pixels nearest the frame resolve first
    "  float order = 0.6 * hash(vec3(px, 7.0)) + 0.4 * clamp(dist / max(extent, 1.0), 0.0, 1.0);",
    "  if (order < u_reveal) discard;",
    "  float random = field(px, 1.0, 3.0);",
    "  float tintRandom = field(px, 2.0, 1.2);",
    "  float grain = field(px, 3.0, 0.24);",
    "  if (random > 0.5 + 0.36 * exp(-dist / 90.0)) {",
    "    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);",
    "    return;",
    "  }",
    "  vec3 color;",
    "  if (tintRandom < exp(-dist / 72.0)) {",
    "    vec3 sampled = texture2D(u_colors, clamp(media, 0.0, 1.0)).rgb;",
    "    sampled = mix(vec3(" + (FALLBACK_COLOR / 255).toFixed(4) + "), sampled, u_colorMix);",
    "    color = sampled * (0.7 + grain * 0.55);",
    "  } else {",
    "    float grey = grain < 0.82 ? random * 48.0 : 165.0 + random * 60.0;",
    "    color = vec3(grey / 255.0);",
    "  }",
    "  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);",
    "}"
  ].join("\n");

  var PARTICLE_VS = [
    "attribute vec2 a_position;",
    "attribute vec4 a_color;",
    "attribute float a_size;",
    "uniform vec2 u_size;",
    "uniform float u_dpr;",
    "varying vec4 v_color;",
    "varying vec2 v_uv;",
    "void main() {",
    "  v_uv = a_position / u_size;",
    "  gl_Position = vec4(v_uv.x * 2.0 - 1.0, 1.0 - v_uv.y * 2.0, 0.0, 1.0);",
    "  gl_PointSize = max(1.0, a_size * u_dpr);",
    "  v_color = a_color;",
    "}"
  ].join("\n");

  var PARTICLE_FS = [
    "precision mediump float;",
    "varying vec4 v_color;",
    "varying vec2 v_uv;",
    "uniform vec4 u_box;",
    "uniform float u_colorMix;",
    "uniform float u_reveal;",
    "void main() {",
    "  vec2 media = (v_uv - u_box.xy) / u_box.zw;",
    "  if (any(lessThan(v_uv, vec2(0.0))) || any(greaterThan(v_uv, vec2(1.0))) ||",
    "      all(greaterThanEqual(media, vec2(0.0))) && all(lessThanEqual(media, vec2(1.0)))) discard;",
    "  vec3 color = mix(vec3(" + (FALLBACK_COLOR / 255).toFixed(4) + "), v_color.rgb, u_colorMix);",
    "  float a = v_color.a * (1.0 - u_reveal);",
    "  gl_FragColor = vec4(color * a, a);",
    "}"
  ].join("\n");

  function compileProgram(gl, vs, fs) {
    function shader(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    var p = gl.createProgram();
    gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  function createNoiseOverlay(tile, video, before) {
    var canvas = document.createElement("canvas");
    canvas.className = "op-noise";
    canvas.setAttribute("aria-hidden", "true");
    tile.insertBefore(canvas, before);
    var attrs = { alpha: true, premultipliedAlpha: true, antialias: false };
    var gl = canvas.getContext("webgl", attrs);
    if (!gl) return null;
    var noiseProgram, particleProgram;
    try {
      noiseProgram = compileProgram(gl, QUAD_VS, NOISE_FS);
      particleProgram = compileProgram(gl, PARTICLE_VS, PARTICLE_FS);
    } catch (e) {
      return null;
    }
    function locations(program, names) {
      var out = {};
      names.forEach(function (n) {
        out[n] = n.charAt(0) === "a" ? gl.getAttribLocation(program, n) : gl.getUniformLocation(program, n);
      });
      return out;
    }
    var nl = locations(noiseProgram, ["a_position", "u_size", "u_scale", "u_box", "u_time", "u_colors", "u_colorMix", "u_reveal"]);
    var pl = locations(particleProgram, ["a_position", "a_color", "a_size", "u_size", "u_dpr", "u_box", "u_colorMix", "u_reveal"]);

    var quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var particleBuffer = gl.createBuffer();
    var particleData = new Float32Array(MAX_PARTICLES * PARTICLE_STRIDE);

    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([FALLBACK_COLOR, FALLBACK_COLOR, FALLBACK_COLOR, 255]));
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    var sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = sampleCanvas.height = COLOR_SAMPLE_SIZE;
    var sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
    var posterImg = new Image();

    var box = [0, 0, 1, 1];
    var colorCount = COLOR_SAMPLE_SIZE * COLOR_SAMPLE_SIZE * 4;
    var target = null, smooth = new Float32Array(colorCount), colors = null;
    var colorFadeStart = 0, lastSample = -Infinity, lastSmooth = 0;
    var reveal = 1, revealFrom = 1, revealTo = 1, revealStart = 0, revealDur = 1;
    var particles = [], lastTime = 0, lastDraw = 0;
    var frameId = 0, visible = true;
    var cssW = 1, cssH = 1, dpr = 1, scale = 1;

    function resize() {
      var r = tile.getBoundingClientRect();
      cssW = Math.max(1, r.width);
      cssH = Math.max(1, r.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      scale = Math.min(dpr, Math.sqrt(650000 / (cssW * cssH)));
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      particles.length = 0;
    }

    // Colors come from the source region only: the original pixels, not the outpaint.
    function sampleColors(now) {
      if (now - lastSample < COLOR_SAMPLE_MS) return;
      var src = null, sw = 0, sh = 0;
      // before playback the decoded frame is often the clip's black first frame; the poster isn't
      var started = !video.paused || video.currentTime > 0;
      if (started && video.readyState >= 2 && video.videoWidth) { src = video; sw = video.videoWidth; sh = video.videoHeight; }
      else if (posterImg.complete && posterImg.naturalWidth) { src = posterImg; sw = posterImg.naturalWidth; sh = posterImg.naturalHeight; }
      if (!src) return;
      lastSample = now;
      try {
        sampleCtx.drawImage(src, box[0] * sw, box[1] * sh, box[2] * sw, box[3] * sh, 0, 0, COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE);
        target = sampleCtx.getImageData(0, 0, COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE).data;
      } catch (e) { /* cross-origin frame without CORS: keep the grey fallback */ }
    }

    // Ease the displayed colors toward the latest sample; the first sample of a clip lands as is.
    function smoothColors(now) {
      if (!target) return;
      var first = !colors;
      if (first) colors = new Uint8Array(colorCount);
      var k = first ? 1 : 1 - Math.exp(-(now - lastSmooth) / COLOR_SMOOTH_MS);
      lastSmooth = now;
      if (k <= 0) return;
      for (var i = 0; i < colorCount; i++) {
        smooth[i] += (target[i] - smooth[i]) * k;
        colors[i] = smooth[i];
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, colors);
      if (first) colorFadeStart = now;
    }

    function colorAt(u, v) {
      if (!colors) return [FALLBACK_COLOR / 255, FALLBACK_COLOR / 255, FALLBACK_COLOR / 255];
      var max = COLOR_SAMPLE_SIZE - 1;
      var i = (Math.round(Math.min(1, Math.max(0, v)) * max) * COLOR_SAMPLE_SIZE + Math.round(Math.min(1, Math.max(0, u)) * max)) * 4;
      return [colors[i] / 255, colors[i + 1] / 255, colors[i + 2] / 255];
    }

    function activeSides() {
      var s = [];
      if (box[0] > 0.001) s.push(0);
      if (box[0] + box[2] < 0.999) s.push(1);
      if (box[1] > 0.001) s.push(2);
      if (box[1] + box[3] < 0.999) s.push(3);
      return s;
    }

    // Particles leave the frame's edges perpendicular to them, in the edge's color.
    function spawn(sides) {
      var side = sides[Math.floor(Math.random() * sides.length)];
      var along = Math.random();
      var u = side === 0 ? 0 : side === 1 ? 1 : along;
      var v = side === 2 ? 0 : side === 3 ? 1 : along;
      var speed = 14 + Math.random() * 44;
      var duration = 1.2 + Math.random() * 2.4;
      return {
        u: u, v: v,
        x: (box[0] + u * box[2]) * cssW,
        y: (box[1] + v * box[3]) * cssH,
        vx: side === 0 ? -speed : side === 1 ? speed : 0,
        vy: side === 2 ? -speed : side === 3 ? speed : 0,
        life: duration, duration: duration,
        size: 1.2 + Math.random() * 1.8,
        color: colorAt(u, v)
      };
    }

    function updateParticles(now) {
      var sides = activeSides();
      if (!sides.length) return 0;
      var dt = Math.min(0.05, (now - lastTime) / 1000 || 0.016);
      lastTime = now;
      var outside = cssW * cssH * (1 - box[2] * box[3]);
      var count = Math.min(MAX_PARTICLES, Math.max(MIN_PARTICLES, Math.round(outside / 220)));
      particles.length = Math.min(particles.length, count);
      while (particles.length < count) {
        var fresh = spawn(sides);
        var age = Math.random() * fresh.duration;
        fresh.x += fresh.vx * age;
        fresh.y += fresh.vy * age;
        fresh.life -= age;
        particles.push(fresh);
      }
      for (var i = 0; i < particles.length; i++) {
        var pt = particles[i];
        pt.life -= dt;
        if (pt.life <= 0) pt = particles[i] = spawn(sides);
        pt.x += pt.vx * dt;
        pt.y += pt.vy * dt;
        var o = i * PARTICLE_STRIDE;
        particleData[o] = pt.x;
        particleData[o + 1] = pt.y;
        particleData[o + 2] = pt.color[0];
        particleData[o + 3] = pt.color[1];
        particleData[o + 4] = pt.color[2];
        particleData[o + 5] = Math.min(1, (pt.life / pt.duration) * 1.6) * 0.95;
        particleData[o + 6] = pt.size;
      }
      return particles.length;
    }

    function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

    function draw() {
      frameId = 0;
      var now = performance.now();
      var animating = reveal !== revealTo;
      if (animating) {
        var t = Math.min(1, (now - revealStart) / revealDur);
        reveal = revealFrom + (revealTo - revealFrom) * easeOut(t);
        if (t >= 1) reveal = revealTo;
      }
      if (reveal >= 1 && revealTo >= 1) {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return;
      }
      schedule();
      var fading = colorFadeStart && now - colorFadeStart < COLOR_FADE_MS;
      if (!animating && !fading && now - lastDraw < IDLE_FRAME_MS) return;
      lastDraw = now;
      sampleColors(now);
      smoothColors(now);
      var colorMix = colorFadeStart ? Math.min(1, (now - colorFadeStart) / COLOR_FADE_MS) : 0;

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(noiseProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      if (pl.a_color >= 0) gl.disableVertexAttribArray(pl.a_color);
      if (pl.a_size >= 0) gl.disableVertexAttribArray(pl.a_size);
      gl.enableVertexAttribArray(nl.a_position);
      gl.vertexAttribPointer(nl.a_position, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(nl.u_colors, 0);
      gl.uniform2f(nl.u_size, cssW, cssH);
      gl.uniform1f(nl.u_scale, scale);
      gl.uniform4f(nl.u_box, box[0], box[1], box[2], box[3]);
      gl.uniform1f(nl.u_time, (now % 1e6) / 1000);
      gl.uniform1f(nl.u_colorMix, colorMix);
      gl.uniform1f(nl.u_reveal, reveal * 1.001);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      var count = updateParticles(now);
      if (!count) return;
      gl.useProgram(particleProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, particleBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, particleData.subarray(0, count * PARTICLE_STRIDE), gl.DYNAMIC_DRAW);
      var stride = PARTICLE_STRIDE * 4;
      gl.enableVertexAttribArray(pl.a_position);
      gl.vertexAttribPointer(pl.a_position, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(pl.a_color);
      gl.vertexAttribPointer(pl.a_color, 4, gl.FLOAT, false, stride, 8);
      gl.enableVertexAttribArray(pl.a_size);
      gl.vertexAttribPointer(pl.a_size, 1, gl.FLOAT, false, stride, 24);
      gl.uniform2f(pl.u_size, cssW, cssH);
      gl.uniform1f(pl.u_dpr, dpr);
      gl.uniform4f(pl.u_box, box[0], box[1], box[2], box[3]);
      gl.uniform1f(pl.u_colorMix, colorMix);
      gl.uniform1f(pl.u_reveal, reveal);
      gl.drawArrays(gl.POINTS, 0, count);
    }

    function schedule() {
      if (!frameId && visible) frameId = requestAnimationFrame(draw);
    }

    function animateTo(target, ms) {
      revealFrom = reveal;
      revealTo = target;
      revealStart = performance.now();
      revealDur = reduceMotion ? 1 : ms;
      schedule();
    }

    resize();
    if ("ResizeObserver" in window) new ResizeObserver(function () { resize(); schedule(); }).observe(tile);
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible) schedule();
      }).observe(tile);
    }

    return {
      setClip: function (newBox, poster) {
        box = newBox;
        target = null;
        colors = null;
        colorFadeStart = 0;
        lastSample = -Infinity;
        particles.length = 0;
        posterImg.src = poster;
        schedule();
      },
      showNoise: function (instant) {
        if (instant) { reveal = revealFrom = revealTo = 0; schedule(); return; }
        animateTo(0, HIDE_MS);
      },
      reveal: function () { animateTo(1, REVEAL_MS); }
    };
  }

  /* ---------------------------------------------------------------
   * Player: one outpainted video, the "Original" overlay, play/scrub,
   * mute, fullscreen, and the Original / Outpainted toggle.
   * Returns { load(id) } so a gallery can swap clips into it.
   * ------------------------------------------------------------- */
  function buildPlayer(fig, opts) {
    opts = opts || {};
    var tile = document.createElement("div");
    tile.className = "video-tile op-canvas has-video";
    tile.innerHTML =
      '<video class="op-video" playsinline preload="metadata" crossorigin="anonymous"></video>' +
      '<button class="video-tile__play" type="button" aria-label="Play">' + PLAY_ICON + "</button>" +
      '<div class="scrubber"><div class="scrubber__track"><div class="scrubber__progress"></div></div></div>';
    fig.insertBefore(tile, fig.firstChild);

    var video = tile.querySelector("video");
    var progress = tile.querySelector(".scrubber__progress");
    var noise = createNoiseOverlay(tile, video, tile.querySelector(".video-tile__play"));
    var autoplay = !!opts.autoplay && !reduceMotion;
    if (opts.autoplay) {
      // Safari only autoplays when muted/playsinline are present as attributes, not just properties
      video.muted = true;
      video.setAttribute("muted", "");
      video.loop = true;
      video.autoplay = autoplay;
    }

    var bar = document.createElement("div");
    bar.className = "op-figure__bar";
    bar.innerHTML =
      '<div class="op-toggle" role="group" aria-label="Framing">' +
        '<button type="button" data-mode="original">Original</button>' +
        '<button type="button" data-mode="outpaint" class="is-active">Outpainted</button>' +
      "</div>";
    var caption = fig.querySelector(".op-figure__caption");
    fig.insertBefore(bar, caption ? caption.nextSibling : tile.nextSibling);
    if (!noise) bar.hidden = true;

    function setMode(original, instant) {
      if (!noise) return;
      if (original === tile.classList.contains("is-original") && !instant) return;
      bar.querySelectorAll("button").forEach(function (x) {
        x.classList.toggle("is-active", (x.getAttribute("data-mode") === "original") === original);
      });
      tile.classList.toggle("is-original", original);
      if (original) { noise.showNoise(instant); } else { noise.reveal(); }
    }
    bar.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        cancelIntro();
        setMode(b.getAttribute("data-mode") === "original");
      });
    });

    // Each clip opens in the generating state and reveals the outpaint once it's been on screen
    // for a beat; an autoplaying clip also waits until it's actually playing, unless autoplay is
    // blocked. Choosing a mode by hand cancels the pending reveal.
    var introPending = false, introTimer = 0, onScreen = false;
    var awaitingPlayback = false, playbackFallback = 0;
    function cancelIntro() {
      introPending = false;
      clearTimeout(introTimer);
    }
    function armIntro() {
      clearTimeout(introTimer);
      if (introPending && onScreen && !awaitingPlayback) {
        introTimer = setTimeout(function () { introPending = false; setMode(false); }, INTRO_DELAY_MS);
      }
    }
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        onScreen = entries[0].isIntersecting;
        if (onScreen) { armIntro(); } else { clearTimeout(introTimer); }
      }, { threshold: 0.6 }).observe(tile);
    } else {
      onScreen = true;
    }

    video.addEventListener("timeupdate", function () {
      if (video.duration) progress.style.left = (video.currentTime / video.duration) * 100 + "%";
    });
    video.addEventListener("play", function () {
      tile.classList.add("is-playing");
      document.querySelectorAll("video").forEach(function (v) { if (v !== video && !v.paused) v.pause(); });
    });
    video.addEventListener("playing", function () {
      if (!awaitingPlayback) return;
      awaitingPlayback = false;
      clearTimeout(playbackFallback);
      armIntro();
    });
    // autoplay can lose a race with the first data arriving; retry once there's something to play
    video.addEventListener("loadeddata", function () {
      if (autoplay && video.paused) video.play().catch(function () {});
    });
    video.addEventListener("pause", function () { tile.classList.remove("is-playing"); });
    video.addEventListener("ended", function () { tile.classList.remove("is-playing"); });
    tile.querySelector(".video-tile__play").addEventListener("click", function () {
      if (video.paused) { video.play().catch(function () {}); } else { video.pause(); }
    });
    tile.querySelector(".scrubber__track").addEventListener("click", function (e) {
      e.stopPropagation();
      if (!video.duration) return;
      var rect = e.currentTarget.getBoundingClientRect();
      video.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * video.duration;
    });
    addMuteToggle(tile, video);
    addFullscreenToggle(tile, video);

    function load(id) {
      var clip = CLIPS[id];
      var box = sourceBox(clip);
      tile.style.setProperty("--ar", clip.out[0] + "/" + clip.out[1]);
      tile.style.setProperty("--arn", String(clip.out[0] / clip.out[1]));
      progress.style.left = "0%";
      // swapping src pauses without firing "pause", so clear the playing state by hand
      tile.classList.remove("is-playing");
      video.poster = posterUrl(id);
      video.src = videoUrl(id);
      if (noise) noise.setClip(box, posterUrl(id));
      if (autoplay) video.play().catch(function () {});
      if (noise && !reduceMotion) {
        setMode(true, true);
        introPending = true;
        awaitingPlayback = autoplay;
        clearTimeout(playbackFallback);
        if (autoplay) {
          playbackFallback = setTimeout(function () { awaitingPlayback = false; armIntro(); }, AUTOPLAY_WAIT_MS);
        }
        armIntro();
      }
    }
    return { load: load };
  }

  function addMuteToggle(tile, video) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "video-tile__mute";
    tile.appendChild(btn);
    function render() {
      btn.innerHTML = video.muted ? ICON_VOL_OFF : ICON_VOL_ON;
      btn.classList.toggle("is-muted", video.muted);
      btn.setAttribute("aria-label", video.muted ? "Unmute" : "Mute");
    }
    render();
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      video.muted = !video.muted;
      render();
    });
  }

  function addFullscreenToggle(tile, video) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "video-tile__fs";
    btn.setAttribute("aria-label", "Fullscreen");
    btn.innerHTML = ICON_FS;
    tile.appendChild(btn);
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var doc = document;
      if (doc.fullscreenElement || doc.webkitFullscreenElement) {
        (doc.exitFullscreen || doc.webkitExitFullscreen || function () {}).call(doc);
      } else if (tile.requestFullscreen) { tile.requestFullscreen(); }
      else if (tile.webkitRequestFullscreen) { tile.webkitRequestFullscreen(); }
      else if (video.webkitEnterFullscreen) { video.webkitEnterFullscreen(); }
    });
  }

  /* ---------------------------------------------------------------
   * Gallery: direction tabs + a thumbnail strip feeding one player.
   * ------------------------------------------------------------- */
  function buildGallery() {
    var fig = document.querySelector('[data-op="gallery"]');
    var tabsEl = document.getElementById("op-tabs");
    var thumbsEl = document.getElementById("op-thumbs");
    if (!fig || !tabsEl || !thumbsEl) return;
    var player = buildPlayer(fig);
    var current = null;

    function select(id) {
      current = id;
      player.load(id);
      thumbsEl.querySelectorAll(".op-thumb").forEach(function (t) {
        t.classList.toggle("is-active", t.getAttribute("data-id") === id);
      });
    }

    function showGroup(gi) {
      tabsEl.querySelectorAll(".tab").forEach(function (t, i) { t.classList.toggle("is-active", i === gi); });
      thumbsEl.innerHTML = "";
      MEDIA.groups[gi].ids.forEach(function (id) {
        var clip = CLIPS[id];
        var b = document.createElement("button");
        b.type = "button";
        b.className = "op-thumb";
        b.setAttribute("data-id", id);
        b.title = clip.title;
        b.setAttribute("aria-label", clip.title);
        b.style.setProperty("--arn", String(clip.out[0] / clip.out[1]));
        b.innerHTML = '<img src="' + posterUrl(id) + '" alt="" loading="lazy" />';
        b.addEventListener("click", function () { if (id !== current) select(id); });
        thumbsEl.appendChild(b);
      });
      select(MEDIA.groups[gi].ids[0]);
    }

    MEDIA.groups.forEach(function (g, i) {
      var tab = document.createElement("button");
      tab.className = "tab";
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.textContent = g.label;
      tab.addEventListener("click", function () { showGroup(i); });
      tabsEl.appendChild(tab);
    });
    showGroup(0);
  }

  /* ---------------------------------------------------------------
   * ATS vs autoregressive: one tick = one round of GPU calls.
   * 49 frames; root anchors every 12, guidance every 4, leaves fill.
   * ------------------------------------------------------------- */
  function treeDemo() {
    var atsRow = document.getElementById("tree-ats-row");
    var arRow = document.getElementById("tree-ar-row");
    if (!atsRow || !arRow) return;
    var atsBr = document.getElementById("tree-ats-brackets");
    var arBr = document.getElementById("tree-ar-brackets");
    var atsStep = document.getElementById("tree-ats-step");
    var arStep = document.getElementById("tree-ar-step");
    var btn = document.getElementById("tree-run");

    var N = 49, ROOT = 12, GUIDE = 4, AR_CHUNK = 4;
    var AR_ROUNDS = Math.ceil((N - 1) / AR_CHUNK);

    function cells(row) {
      row.style.gridTemplateColumns = "repeat(" + N + ", minmax(0, 1fr))";
      row.innerHTML = "";
      var out = [];
      for (var i = 0; i < N; i++) {
        var c = document.createElement("span");
        c.className = "tcell";
        row.appendChild(c);
        out.push(c);
      }
      return out;
    }
    function bracket(host, a, b) {
      var el = document.createElement("span");
      el.className = "tree__bracket";
      el.style.left = (a / N * 100) + "%";
      el.style.width = ((b - a + 1) / N * 100) + "%";
      host.appendChild(el);
    }
    function mark(cell, cls) { cell.className = "tcell " + cls + " is-new"; }
    function mix(a, b, t) {
      var pa = [1, 3, 5].map(function (i) { return parseInt(a.slice(i, i + 2), 16); });
      var pb = [1, 3, 5].map(function (i) { return parseInt(b.slice(i, i + 2), 16); });
      return "rgb(" + pa.map(function (v, i) { return Math.round(v + (pb[i] - v) * t); }).join(",") + ")";
    }

    // ATS levels as lists of calls, each a bracket [a, b] and the cells it writes.
    var root = { name: "root", cls: "is-root", calls: [{ a: 0, b: N - 1, cells: [] }] };
    for (var r = 0; r < N; r += ROOT) root.calls[0].cells.push(r);
    var guide = { name: "guidance", cls: "is-guide", calls: [] };
    for (var a = 0; a + ROOT < N; a += ROOT) {
      var g = { a: a, b: a + ROOT, cells: [] };
      for (var x = a + GUIDE; x < a + ROOT; x += GUIDE) g.cells.push(x);
      guide.calls.push(g);
    }
    var leaf = { name: "leaves", cls: "is-leaf", calls: [] };
    for (var s = 0; s + GUIDE < N; s += GUIDE) {
      var l = { a: s, b: s + GUIDE, cells: [] };
      for (var y = s + 1; y < s + GUIDE; y++) l.cells.push(y);
      leaf.calls.push(l);
    }
    var levels = [root, guide, leaf];

    var atsCells, arCells, timer = null, tick = 0;

    function reset() {
      if (timer) { clearInterval(timer); timer = null; }
      tick = 0;
      atsCells = cells(atsRow);
      arCells = cells(arRow);
      atsBr.innerHTML = "";
      arBr.innerHTML = "";
      atsStep.textContent = "";
      arStep.textContent = "";
    }

    function step() {
      tick += 1;
      atsBr.innerHTML = "";
      arBr.innerHTML = "";
      if (tick <= levels.length) {
        var lvl = levels[tick - 1];
        lvl.calls.forEach(function (call) {
          bracket(atsBr, call.a, call.b);
          call.cells.forEach(function (i) { mark(atsCells[i], lvl.cls); });
        });
        var n = lvl.calls.length;
        atsStep.textContent = "round " + tick + " · " + lvl.name + " · " + n + (n === 1 ? " call" : " parallel calls");
      } else {
        atsStep.textContent = "done in " + levels.length + " rounds";
      }
      var start = (tick - 1) * AR_CHUNK + (tick === 1 ? 0 : 1);
      var end = Math.min(N - 1, tick * AR_CHUNK);
      bracket(arBr, Math.max(0, start - 1), end);
      var drift = (tick - 1) / (AR_ROUNDS - 1);
      for (var i = start; i <= end; i++) {
        mark(arCells[i], "is-ar");
        arCells[i].style.backgroundColor = mix("#FF8969", "#9FB08A", Math.min(1, drift + (Math.random() - 0.5) * 0.12));
      }
      arStep.textContent = tick < AR_ROUNDS ? "round " + tick + " / " + AR_ROUNDS : "done in " + AR_ROUNDS + " rounds";
      if (tick >= AR_ROUNDS) {
        clearInterval(timer);
        timer = null;
        arBr.innerHTML = "";
        atsBr.innerHTML = "";
      }
    }

    function run() {
      reset();
      if (reduceMotion) { while (tick < AR_ROUNDS) step(); return; }
      step();
      timer = setInterval(step, 850);
    }

    reset();
    if (btn) btn.addEventListener("click", run);
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (e.isIntersecting) { run(); io.disconnect(); } });
      }, { threshold: 0.5 });
      io.observe(atsRow);
    } else {
      run();
    }
  }

  /* ---------------------------------------------------------------
   * Citation copy.
   * ------------------------------------------------------------- */
  function setupCite(btn) {
    var pre = btn.parentNode.querySelector("pre");
    btn.addEventListener("click", function () {
      var done = function () {
        btn.classList.add("copied");
        btn.textContent = "Copied ✓";
        setTimeout(function () { btn.classList.remove("copied"); btn.textContent = "Copy"; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(pre.textContent).then(done, done);
      } else {
        var ta = document.createElement("textarea");
        ta.value = pre.textContent; document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); } catch (e) {}
        document.body.removeChild(ta); done();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var hero = document.querySelector('[data-op="hero"]');
    if (hero) buildPlayer(hero, { autoplay: true }).load(MEDIA.hero);
    buildGallery();
    treeDemo();
    document.querySelectorAll(".cite-copy").forEach(setupCite);
  });
})();
