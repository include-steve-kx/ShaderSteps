// ============================================================
// ShaderEngine — WebGL2 ShaderToy-compatible renderer
// ============================================================
// All rendering happens on a single hidden canvas. Visible 2D
// canvases receive output via blit + drawImage per frame.
// ============================================================

const PASS_ORDER = ['A', 'B', 'C', 'D', 'Image'];

// ---- Shader preamble (prepended to every pass) ----
const PREAMBLE = `#version 300 es
#ifdef GL_ES
precision highp float;
precision highp int;
precision mediump sampler3D;
#endif
#define texture2D texture
uniform vec3      iResolution;
uniform float     iTime;
uniform float     iTimeDelta;
uniform float     iFrameRate;
uniform int       iFrame;
uniform float     iChannelTime[4];
uniform vec3      iChannelResolution[4];
uniform vec4      iMouse;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform sampler2D iChannel3;
uniform vec4      iDate;
uniform float     iSampleRate;
out vec4          frag_out_color;
void mainImage(out vec4 c, in vec2 f);
void main(void) {
    vec4 color = vec4(0.0);
    mainImage(color, gl_FragCoord.xy);
    frag_out_color = color;
}
`;

const PREAMBLE_LINE_COUNT = PREAMBLE.split('\n').length;

// ---- Basic vertex shader ----
const VERTEX_SHADER = `#version 300 es
precision highp float;
in vec2 aPosition;
void main() {
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

// ---- Blit fragment shader (used to copy FBO tex to screen) ----
const BLIT_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uTexture;
uniform vec2 uResolution;
out vec4 fragColor;
void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    fragColor = texture(uTexture, uv);
}
`;

// ---- Fullscreen quad (two triangles) ----
const QUAD_VERTICES = new Float32Array([
  -1, -1,  1, -1,  -1, 1,
   1,  1, -1,  1,   1, -1,
]);


export class ShaderEngine {

  // ---- Constructor ----
  constructor(hiddenCanvas) {
    this._canvas = hiddenCanvas;
    const opts = {
      alpha: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      antialias: false,
      preserveDrawingBuffer: true,   // needed for drawImage copies
      powerPreference: 'high-performance',
    };
    this._gl = hiddenCanvas.getContext('webgl2', opts);
    if (!this._gl) throw new Error('WebGL2 not supported');
    const gl = this._gl;

    // Extensions
    gl.getExtension('OES_texture_float_linear');
    gl.getExtension('EXT_color_buffer_float');

    // ---- Per-pass state ----
    // source code (user-provided)
    this._source = {};
    // common code
    this._common = '';
    // compiled program per pass
    this._program = {};
    // uniform locations per pass
    this._uloc = {};
    // channel config per pass: _channels['A'] = ['B', null, null, null]
    this._channels = {};
    // Ping-pong textures & FBOs for every pass (including Image)
    this._texA = {};
    this._texB = {};
    this._fboA = {};
    this._fboB = {};
    this._flip = {};

    for (const key of PASS_ORDER) {
      this._source[key] = null;
      this._program[key] = null;
      this._uloc[key] = {};
      this._channels[key] = [null, null, null, null];
      this._texA[key] = this._createTexture();
      this._texB[key] = this._createTexture();
      this._fboA[key] = this._createFBO(this._texA[key]);
      this._fboB[key] = this._createFBO(this._texB[key]);
      this._flip[key] = false;
    }

    // ---- Quad buffer ----
    this._quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTICES, gl.STATIC_DRAW);

    // ---- Blit program ----
    this._blitProgram = this._compileRawProgram(VERTEX_SHADER, BLIT_FRAGMENT);
    this._blitUloc = {
      uTexture: gl.getUniformLocation(this._blitProgram, 'uTexture'),
      uResolution: gl.getUniformLocation(this._blitProgram, 'uResolution'),
      aPosition: gl.getAttribLocation(this._blitProgram, 'aPosition'),
    };

    // ---- Display canvases ----
    // Map<passKey, { canvas, ctx2d, visible }>
    this._displayTargets = new Map();

    // ---- Timing ----
    this._isPlaying = false;
    this._startTime = 0;    // performance.now() at play start
    this._elapsed = 0;      // accumulated time when paused
    this._prevFrameTime = 0;
    this._frameCount = 0;
    this._animId = null;

    // ---- Mouse ----
    this._mouse = { x: 0, y: 0, clickX: 0, clickY: 0 };

    // Viewport
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
  }

  // ===========================================================
  // Configuration
  // ===========================================================

  setCommon(source) {
    this._common = source || '';
  }

  setPass(key, source) {
    if (!PASS_ORDER.includes(key)) return;
    this._source[key] = source || null;
  }

  removePass(key) {
    if (!PASS_ORDER.includes(key)) return;
    this._source[key] = null;
    this._program[key] = null;
  }

  setChannel(passKey, channelIdx, sourceKey) {
    if (!this._channels[passKey]) return;
    this._channels[passKey][channelIdx] = sourceKey || null;
  }

  getChannel(passKey, channelIdx) {
    return this._channels[passKey]?.[channelIdx] ?? null;
  }

  getActivePasses() {
    return PASS_ORDER.filter(k => this._source[k] != null && this._source[k].trim() !== '');
  }

  // ===========================================================
  // Compilation
  // ===========================================================

  compile() {
    const errors = [];
    const gl = this._gl;

    for (const key of PASS_ORDER) {
      const src = this._source[key];
      if (src == null || src.trim() === '') {
        this._program[key] = null;
        continue;
      }

      const fragSource = PREAMBLE + this._common + '\n' + src;

      // Vertex shader
      const vert = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vert, VERTEX_SHADER);
      gl.compileShader(vert);
      if (!gl.getShaderParameter(vert, gl.COMPILE_STATUS)) {
        errors.push({ pass: key, message: '[vertex] ' + gl.getShaderInfoLog(vert) });
        gl.deleteShader(vert);
        this._program[key] = null;
        continue;
      }

      // Fragment shader
      const frag = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(frag, fragSource);
      gl.compileShader(frag);
      if (!gl.getShaderParameter(frag, gl.COMPILE_STATUS)) {
        const raw = gl.getShaderInfoLog(frag) || '';
        // Try to adjust line numbers: subtract preamble lines
        const adjusted = raw.replace(/ERROR:\s*0:(\d+)/g, (_m, lineStr) => {
          const adjusted_line = Math.max(1, parseInt(lineStr) - PREAMBLE_LINE_COUNT - this._common.split('\n').length);
          return `ERROR: 0:${adjusted_line}`;
        });
        errors.push({ pass: key, message: adjusted });
        gl.deleteShader(vert);
        gl.deleteShader(frag);
        this._program[key] = null;
        continue;
      }

      // Link
      const prog = gl.createProgram();
      gl.attachShader(prog, vert);
      gl.attachShader(prog, frag);
      gl.linkProgram(prog);
      gl.deleteShader(vert);
      gl.deleteShader(frag);

      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        errors.push({ pass: key, message: '[link] ' + gl.getProgramInfoLog(prog) });
        gl.deleteProgram(prog);
        this._program[key] = null;
        continue;
      }

      // Cache uniform locations
      this._program[key] = prog;
      this._uloc[key] = {
        iResolution:        gl.getUniformLocation(prog, 'iResolution'),
        iTime:              gl.getUniformLocation(prog, 'iTime'),
        iTimeDelta:         gl.getUniformLocation(prog, 'iTimeDelta'),
        iFrameRate:         gl.getUniformLocation(prog, 'iFrameRate'),
        iFrame:             gl.getUniformLocation(prog, 'iFrame'),
        iChannelTime:       gl.getUniformLocation(prog, 'iChannelTime[0]'),
        iChannelResolution: gl.getUniformLocation(prog, 'iChannelResolution[0]'),
        iChannel0:          gl.getUniformLocation(prog, 'iChannel0'),
        iChannel1:          gl.getUniformLocation(prog, 'iChannel1'),
        iChannel2:          gl.getUniformLocation(prog, 'iChannel2'),
        iChannel3:          gl.getUniformLocation(prog, 'iChannel3'),
        iMouse:             gl.getUniformLocation(prog, 'iMouse'),
        iDate:              gl.getUniformLocation(prog, 'iDate'),
        iSampleRate:        gl.getUniformLocation(prog, 'iSampleRate'),
        aPosition:          gl.getAttribLocation(prog, 'aPosition'),
      };
    }

    // Reset frame count on recompile
    this._frameCount = 0;

    return { success: errors.length === 0, errors };
  }

  // ===========================================================
  // Display canvas registration
  // ===========================================================

  registerDisplayCanvas(passKey, canvasElement) {
    const ctx = canvasElement.getContext('2d');
    this._displayTargets.set(passKey, { canvas: canvasElement, ctx, visible: true });
  }

  unregisterDisplayCanvas(passKey) {
    this._displayTargets.delete(passKey);
  }

  setDisplayVisible(passKey, visible) {
    const target = this._displayTargets.get(passKey);
    if (target) target.visible = visible;
  }

  // ===========================================================
  // Mouse
  // ===========================================================

  updateMouse(x, y, clickX, clickY) {
    this._mouse.x = x;
    this._mouse.y = y;
    this._mouse.clickX = clickX;
    this._mouse.clickY = clickY;
  }

  // ===========================================================
  // Playback
  // ===========================================================

  play() {
    if (this._isPlaying) return;
    this._isPlaying = true;
    this._startTime = performance.now();
    this._prevFrameTime = performance.now();
    this._tick();
  }

  pause() {
    if (!this._isPlaying) return;
    this._isPlaying = false;
    this._elapsed += (performance.now() - this._startTime) / 1000;
    if (this._animId != null) {
      cancelAnimationFrame(this._animId);
      this._animId = null;
    }
  }

  resetTime() {
    this._elapsed = 0;
    this._startTime = performance.now();
    this._prevFrameTime = performance.now();
    this._frameCount = 0;
    // Render one frame so canvas updates immediately
    this._renderFrame();
    this._displayAll();
  }

  get time() {
    if (this._isPlaying) {
      return this._elapsed + (performance.now() - this._startTime) / 1000;
    }
    return this._elapsed;
  }

  get frame() {
    return this._frameCount;
  }

  get isPlaying() {
    return this._isPlaying;
  }

  // ===========================================================
  // Internal: animation loop
  // ===========================================================

  _tick() {
    if (!this._isPlaying) return;
    this._renderFrame();
    this._displayAll();
    this._animId = requestAnimationFrame(() => this._tick());
  }

  // ===========================================================
  // Internal: render one frame (all passes to FBOs)
  // ===========================================================

  _renderFrame() {
    const gl = this._gl;
    const w = gl.canvas.width;
    const h = gl.canvas.height;
    const now = performance.now();

    // Time values
    const iTime = this.time;
    const iTimeDelta = (now - this._prevFrameTime) / 1000;
    const iFrameRate = iTimeDelta > 0 ? 1 / iTimeDelta : 60;
    this._prevFrameTime = now;

    const date = new Date();
    const iDate = [
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds() + date.getMilliseconds() / 1000,
    ];

    const iChannelTimes = new Float32Array([iTime, iTime, iTime, iTime]);
    const iChannelResolutions = new Float32Array([
      w, h, 0,  w, h, 0,  w, h, 0,  w, h, 0,
    ]);

    for (const key of PASS_ORDER) {
      const prog = this._program[key];
      if (!prog) continue;

      const u = this._uloc[key];

      // Bind output FBO (ping-pong)
      const outFBO = this._flip[key] ? this._fboB[key] : this._fboA[key];
      gl.bindFramebuffer(gl.FRAMEBUFFER, outFBO);
      gl.viewport(0, 0, w, h);

      // Bind input channel textures
      for (let i = 0; i < 4; i++) {
        const chKey = this._channels[key][i];
        if (chKey && (this._texA[chKey] || this._texB[chKey])) {
          // Read from the opposite side of the ping-pong
          const tex = this._flip[chKey] ? this._texA[chKey] : this._texB[chKey];
          gl.activeTexture(gl.TEXTURE0 + i);
          gl.bindTexture(gl.TEXTURE_2D, tex);
        } else {
          gl.activeTexture(gl.TEXTURE0 + i);
          gl.bindTexture(gl.TEXTURE_2D, null);
        }
      }

      // Use program & set uniforms
      gl.useProgram(prog);

      gl.uniform3f(u.iResolution, w, h, 1.0);
      gl.uniform1f(u.iTime, iTime);
      gl.uniform1f(u.iTimeDelta, iTimeDelta);
      gl.uniform1f(u.iFrameRate, iFrameRate);
      gl.uniform1i(u.iFrame, this._frameCount);
      gl.uniform1fv(u.iChannelTime, iChannelTimes);
      gl.uniform3fv(u.iChannelResolution, iChannelResolutions);
      gl.uniform1i(u.iChannel0, 0);
      gl.uniform1i(u.iChannel1, 1);
      gl.uniform1i(u.iChannel2, 2);
      gl.uniform1i(u.iChannel3, 3);
      gl.uniform4f(u.iMouse, this._mouse.x, this._mouse.y, this._mouse.clickX, this._mouse.clickY);
      gl.uniform4f(u.iDate, iDate[0], iDate[1], iDate[2], iDate[3]);
      gl.uniform1f(u.iSampleRate, 44100);

      // Draw quad
      gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf);
      gl.vertexAttribPointer(u.aPosition, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(u.aPosition);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // Flip ping-pong
      this._flip[key] = !this._flip[key];
    }

    this._frameCount++;
  }

  // ===========================================================
  // Internal: display step — blit each pass to its visible canvas
  // ===========================================================

  _displayAll() {
    const gl = this._gl;
    const w = gl.canvas.width;
    const h = gl.canvas.height;

    for (const [passKey, target] of this._displayTargets) {
      if (!target.visible) continue;
      if (!this._program[passKey]) continue;

      // After flip, the latest output texture is:
      //   flip=true  → we just wrote to fboA (texA) → read texA
      //   flip=false → we just wrote to fboB (texB) → read texB
      const tex = this._flip[passKey] ? this._texA[passKey] : this._texB[passKey];

      // Blit to hidden canvas screen
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(this._blitProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(this._blitUloc.uTexture, 0);
      gl.uniform2f(this._blitUloc.uResolution, w, h);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf);
      gl.vertexAttribPointer(this._blitUloc.aPosition, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(this._blitUloc.aPosition);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // Copy to the visible 2D canvas
      const dstCanvas = target.canvas;
      target.ctx.drawImage(gl.canvas, 0, 0, dstCanvas.width, dstCanvas.height);
    }
  }

  // ===========================================================
  // Blit a specific pass to an arbitrary canvas (for maximize)
  // ===========================================================

  blitToCanvas(passKey, targetCanvas) {
    const gl = this._gl;
    const w = gl.canvas.width;
    const h = gl.canvas.height;

    const tex = this._flip[passKey] ? this._texA[passKey] : this._texB[passKey];
    if (!tex) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._blitProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this._blitUloc.uTexture, 0);
    gl.uniform2f(this._blitUloc.uResolution, w, h);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf);
    gl.vertexAttribPointer(this._blitUloc.aPosition, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(this._blitUloc.aPosition);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    const ctx = targetCanvas.getContext('2d');
    ctx.drawImage(gl.canvas, 0, 0, targetCanvas.width, targetCanvas.height);
  }

  // ===========================================================
  // Internal: WebGL helpers
  // ===========================================================

  _createTexture() {
    const gl = this._gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F,
      gl.canvas.width, gl.canvas.height, 0,
      gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  _createFBO(texture) {
    const gl = this._gl;
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return fbo;
  }

  _compileRawProgram(vertSrc, fragSrc) {
    const gl = this._gl;

    const vert = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vert, vertSrc);
    gl.compileShader(vert);
    if (!gl.getShaderParameter(vert, gl.COMPILE_STATUS)) {
      console.error('Blit vert:', gl.getShaderInfoLog(vert));
    }

    const frag = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(frag, fragSrc);
    gl.compileShader(frag);
    if (!gl.getShaderParameter(frag, gl.COMPILE_STATUS)) {
      console.error('Blit frag:', gl.getShaderInfoLog(frag));
    }

    const prog = gl.createProgram();
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    gl.deleteShader(vert);
    gl.deleteShader(frag);

    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('Blit link:', gl.getProgramInfoLog(prog));
    }
    return prog;
  }
}
