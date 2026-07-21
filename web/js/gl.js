/**
 * WebGL2 渲染器 —— PRD §7 双路径管线：
 *   路径 1（参考图驱动 = 逐图匹配）：shader 内 sRGB→Lab→仿射(6 uniform)→sRGB
 *   路径 2（导入 .cube / 内置模版）：3D LUT 纹理三线性采样
 * 换色调的 150ms crossfade：shader 同时求 prev/curr 两个变换，按 uToneLerp 混合。
 * 强度滑杆 = 原图与变换结果在 sRGB 空间的 mix 系数（与 m0 一致）。
 */

const VS = `#version 300 es
layout(location=0) in vec2 aPos;          // 单位四边形 0..1
uniform vec4 uRect;                       // 目标矩形（clip 空间 x,y,w,h）
uniform vec4 uUvRect;                     // 纹理采样窗口（cover 裁切用）
out vec2 vUv;
void main() {
  vUv = uUvRect.xy + aPos * uUvRect.zw;
  vec2 p = uRect.xy + aPos * uRect.zw;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  gl_Position.y = -gl_Position.y;
}`;

const FS = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform sampler3D uLutA;
uniform sampler3D uLutB;
uniform int uModeA;                       // 0=identity 1=Lab仿射 2=LUT
uniform int uModeB;
uniform vec3 uScaleA; uniform vec3 uOffsetA;
uniform vec3 uScaleB; uniform vec3 uOffsetB;
uniform float uToneLerp;                  // prev→curr 过渡
uniform float uStrength;                  // 强度滑杆
uniform float uAlpha;
uniform float uLutSize;
uniform int uUseTex;                      // 0=纯色（选中框等）
uniform vec4 uColor;

vec3 srgb2lin(vec3 c) {
  bvec3 lo = lessThanEqual(c, vec3(0.04045));
  return mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, vec3(lo));
}
vec3 lin2srgb(vec3 c) {
  c = max(c, 0.0);
  bvec3 lo = lessThanEqual(c, vec3(0.0031308));
  return mix(1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, c * 12.92, vec3(lo));
}
const mat3 RGB2XYZ = mat3(0.4124564, 0.2126729, 0.0193339,
                          0.3575761, 0.7151522, 0.1191920,
                          0.1804375, 0.0721750, 0.9503041);
const mat3 XYZ2RGB = mat3(3.2404542, -0.9692660, 0.0556434,
                          -1.5371385, 1.8760108, -0.2040259,
                          -0.4985314, 0.0415560, 1.0572252);
const vec3 WHITE = vec3(0.95047, 1.0, 1.08883);
const float DD = 6.0 / 29.0;

vec3 lin2lab(vec3 lin) {
  vec3 t = (RGB2XYZ * lin) / WHITE;
  bvec3 big = greaterThan(t, vec3(DD * DD * DD));
  vec3 f = mix(t / (3.0 * DD * DD) + 4.0 / 29.0, pow(max(t, 1e-8), vec3(1.0 / 3.0)), vec3(big));
  return vec3(116.0 * f.y - 16.0, 500.0 * (f.x - f.y), 200.0 * (f.y - f.z));
}
vec3 lab2lin(vec3 lab) {
  float fy = (lab.x + 16.0) / 116.0;
  vec3 f = vec3(fy + lab.y / 500.0, fy, fy - lab.z / 200.0);
  bvec3 big = greaterThan(f, vec3(DD));
  vec3 xyz = mix(3.0 * DD * DD * (f - 4.0 / 29.0), f * f * f, vec3(big)) * WHITE;
  return XYZ2RGB * xyz;
}

vec3 applyTone(int mode, vec3 srgb, vec3 sc, vec3 off, sampler3D lut) {
  if (mode == 1) {
    vec3 lab = lin2lab(srgb2lin(srgb)) * sc + off;
    return clamp(lin2srgb(lab2lin(lab)), 0.0, 1.0);
  }
  if (mode == 2) {
    vec3 coord = srgb * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize;
    return texture(lut, coord).rgb;
  }
  return srgb;
}

void main() {
  if (uUseTex == 0) { outColor = uColor; return; }
  vec4 tex = texture(uTex, vUv);
  vec3 srgb = tex.rgb;
  vec3 a = applyTone(uModeA, srgb, uScaleA, uOffsetA, uLutA);
  vec3 b = applyTone(uModeB, srgb, uScaleB, uOffsetB, uLutB);
  vec3 toned = mix(a, b, uToneLerp);
  outColor = vec4(mix(srgb, toned, uStrength), tex.a * uAlpha);
}`;

const IDENTITY_TONE = { mode: 0, scale: [1, 1, 1], offset: [0, 0, 0], lut: null };

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false });
    if (!gl) throw new Error('WebGL2 不可用');
    this.gl = gl;

    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this.u = {};
    for (const name of ['uRect', 'uUvRect', 'uTex', 'uLutA', 'uLutB', 'uModeA', 'uModeB',
      'uScaleA', 'uOffsetA', 'uScaleB', 'uOffsetB', 'uToneLerp', 'uStrength', 'uAlpha',
      'uLutSize', 'uUseTex', 'uColor']) this.u[name] = gl.getUniformLocation(prog, name);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1i(this.u.uTex, 0);
    gl.uniform1i(this.u.uLutA, 1);
    gl.uniform1i(this.u.uLutB, 2);

    // 空 LUT 占位（避免未绑定 sampler 的未定义行为）
    this._emptyLut = this.createLutTexture(new Uint8Array(3), 1);
  }

  resize(w, h, dpr) {
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.viewW = w; this.viewH = h;
  }

  createImageTexture(source) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  createLutTexture(rgbData, size) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, size, size, size, 0, gl.RGB, gl.UNSIGNED_BYTE, rgbData);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    tex._size = size;
    return tex;
  }

  deleteTexture(tex) { if (tex) this.gl.deleteTexture(tex); }

  clear(r = 0.051, g = 0.051, b = 0.059) {
    this.gl.clearColor(r, g, b, 1);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  /** 限制后续绘制到指定区域（CSS 像素；scissor 原点在左下，此处换算）。 */
  setClip(x, y, w, h) {
    const gl = this.gl;
    const dpr = this.canvas.width / this.viewW;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(Math.round(x * dpr), Math.round(this.canvas.height - (y + h) * dpr),
      Math.round(w * dpr), Math.round(h * dpr));
  }

  clearClip() { this.gl.disable(this.gl.SCISSOR_TEST); }

  /** 纯色矩形（选中描边等）。rect 为 CSS 像素。 */
  drawRect(rect, color) {
    const gl = this.gl;
    gl.uniform1i(this.u.uUseTex, 0);
    gl.uniform4fv(this.u.uColor, color);
    gl.uniform4f(this.u.uRect, rect.x / this.viewW, rect.y / this.viewH,
      rect.w / this.viewW, rect.h / this.viewH);
    gl.uniform4f(this.u.uUvRect, 0, 0, 1, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * 绘制一张图。toneA/toneB = {mode, scale, offset, lut}，lerp 为 A→B 过渡进度。
   * uvRect 用于 cover 裁切；rect 为 CSS 像素。
   */
  drawImage(tex, rect, { toneA = IDENTITY_TONE, toneB = IDENTITY_TONE, lerp = 1,
    strength = 1, alpha = 1, uvRect = { x: 0, y: 0, w: 1, h: 1 } } = {}) {
    const gl = this.gl;
    gl.uniform1i(this.u.uUseTex, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const bindLut = (unit, tone) => {
      gl.activeTexture(unit);
      gl.bindTexture(gl.TEXTURE_3D, tone.mode === 2 && tone.lut ? tone.lut : this._emptyLut);
    };
    bindLut(gl.TEXTURE1, toneA);
    bindLut(gl.TEXTURE2, toneB);
    const lutSize = (toneB.mode === 2 && toneB.lut?._size) || (toneA.mode === 2 && toneA.lut?._size) || 1;
    gl.uniform1f(this.u.uLutSize, lutSize);
    gl.uniform1i(this.u.uModeA, toneA.mode);
    gl.uniform1i(this.u.uModeB, toneB.mode);
    gl.uniform3fv(this.u.uScaleA, toneA.scale);
    gl.uniform3fv(this.u.uOffsetA, toneA.offset);
    gl.uniform3fv(this.u.uScaleB, toneB.scale);
    gl.uniform3fv(this.u.uOffsetB, toneB.offset);
    gl.uniform1f(this.u.uToneLerp, lerp);
    gl.uniform1f(this.u.uStrength, strength);
    gl.uniform1f(this.u.uAlpha, alpha);
    gl.uniform4f(this.u.uRect, rect.x / this.viewW, rect.y / this.viewH,
      rect.w / this.viewW, rect.h / this.viewH);
    gl.uniform4f(this.u.uUvRect, uvRect.x, uvRect.y, uvRect.w, uvRect.h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

export { IDENTITY_TONE };
