import * as THREE from 'three';

export type SpatialAction =
  | 'prev'
  | 'next'
  | 'reset'
  | 'light'
  | 'passthrough'
  | 'recenter'
  | 'follow'
  | 'dismiss';

export interface SpatialUIOptions {
  onAction: (action: SpatialAction) => void;
}

interface HudButton {
  action: SpatialAction;
  label: string;
  sub: string;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
}

const BUTTON_DEFS: Array<{ action: SpatialAction; label: string; sub: string }> = [
  { action: 'prev', label: '◀ Prev', sub: 'asset' },
  { action: 'next', label: 'Next ▶', sub: 'asset' },
  { action: 'reset', label: '⟲ Reset', sub: 'transform' },
  { action: 'light', label: '💡 Light', sub: 'cycle' },
  { action: 'passthrough', label: '👁 MR', sub: 'VR ⇄ AR' },
  { action: 'recenter', label: '◎ HUD', sub: 'recenter' },
  { action: 'follow', label: '🧲 Follow', sub: 'on/off' },
  { action: 'dismiss', label: '✕ Hide', sub: 'grip = show' }
];

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  return { canvas, ctx };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * In-headset spatial HUD.
 *
 * - World-locked by default (zero drift): it only moves when the user
 *   presses Recenter or enables Follow.
 * - All buttons are plain meshes in `interactive` so the app can raycast
 *   them with controller rays.
 * - Includes a 3D loading progress bar (used while GLBs decode).
 */
export class SpatialUI {
  readonly group = new THREE.Group();
  private buttons: HudButton[] = [];
  private headerCanvas!: HTMLCanvasElement;
  private headerCtx!: CanvasRenderingContext2D;
  private headerTexture!: THREE.CanvasTexture;
  private barBg!: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private barFill!: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private barLabel!: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private barLabelCanvas!: HTMLCanvasElement;
  private barLabelCtx!: CanvasRenderingContext2D;
  private barLabelTexture!: THREE.CanvasTexture;
  private modelName = '—';
  private modelCount = '';
  private scaleText = '100%';
  private lightText = 'Studio';
  private followEnabled = false;
  private hovered: THREE.Object3D | null = null;
  private loadProgress = -1;
  private onAction: (action: SpatialAction) => void;

  constructor(options: SpatialUIOptions) {
    this.onAction = options.onAction;
    this.build();
    this.group.visible = false;
  }

  // ---------------------------------------------------------------- build

  private build(): void {
    // Backing plate
    const plateCanvas = document.createElement('canvas');
    plateCanvas.width = 4;
    plateCanvas.height = 4;
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(0.72, 0.52),
      new THREE.MeshBasicMaterial({ color: new THREE.Color('#0d1322'), transparent: true, opacity: 0.88, side: THREE.DoubleSide })
    );
    plate.position.z = -0.002;
    plate.renderOrder = -1;
    this.group.add(plate);

    // Border frame (thin bright edge via canvas texture)
    const frame = document.createElement('canvas');
    frame.width = 512;
    frame.height = 372;
    const fctx = frame.getContext('2d');
    if (fctx) {
      fctx.strokeStyle = 'rgba(91,140,255,0.9)';
      fctx.lineWidth = 6;
    fctx.beginPath();
    if (typeof fctx.roundRect === 'function') fctx.roundRect(6, 6, 500, 360, 28);
    else fctx.rect(6, 6, 500, 360);
      fctx.stroke();
    }
    const frameTex = new THREE.CanvasTexture(frame);
    frameTex.colorSpace = THREE.SRGBColorSpace;
    const frameMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.72, 0.52),
      new THREE.MeshBasicMaterial({ map: frameTex, transparent: true, toneMapped: false, depthWrite: false })
    );
    frameMesh.position.z = -0.001;
    this.group.add(frameMesh);

    // Header (model name + scale + lighting)
    const header = makeCanvas(1024, 168);
    this.headerCanvas = header.canvas;
    this.headerCtx = header.ctx;
    this.headerTexture = new THREE.CanvasTexture(this.headerCanvas);
    this.headerTexture.colorSpace = THREE.SRGBColorSpace;
    this.headerTexture.anisotropy = 4;
    const headerMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.66, 0.109),
      new THREE.MeshBasicMaterial({ map: this.headerTexture, transparent: true, toneMapped: false })
    );
    headerMesh.position.set(0, 0.185, 0.001);
    this.group.add(headerMesh);

    // Buttons: 4 cols x 2 rows
    const bw = 0.155;
    const bh = 0.075;
    const gapX = 0.012;
    const gapY = 0.012;
    const startX = -((bw * 4 + gapX * 3) / 2 - bw / 2);
    const startY = 0.095;
    BUTTON_DEFS.forEach((def, i) => {
      const col = i % 4;
      const row = Math.floor(i / 4);
      const { canvas, ctx } = makeCanvas(256, 128);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 4;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(bw, bh),
        new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false })
      );
      mesh.position.set(startX + col * (bw + gapX), startY - row * (bh + gapY), 0.001);
      mesh.userData.spatialAction = def.action as SpatialAction;
      const btn: HudButton = { ...def, mesh, canvas, ctx, texture };
      this.buttons.push(btn);
      this.group.add(mesh);
      this.drawButton(btn, false);
    });

    // 3D loading bar
    const barLabel = makeCanvas(1024, 64);
    this.barLabelCanvas = barLabel.canvas;
    this.barLabelCtx = barLabel.ctx;
    this.barLabelTexture = new THREE.CanvasTexture(this.barLabelCanvas);
    this.barLabelTexture.colorSpace = THREE.SRGBColorSpace;
    this.barLabel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.66, 0.041),
      new THREE.MeshBasicMaterial({ map: this.barLabelTexture, transparent: true, toneMapped: false })
    );
    this.barLabel.position.set(0, -0.115, 0.001);
    this.group.add(this.barLabel);

    this.barBg = new THREE.Mesh(
      new THREE.PlaneGeometry(0.66, 0.028),
      new THREE.MeshBasicMaterial({ color: new THREE.Color('#1b2540'), transparent: true, opacity: 0.95, toneMapped: false })
    );
    this.barBg.position.set(0, -0.155, 0.001);
    this.group.add(this.barBg);

    this.barFill = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: new THREE.Color('#5b8cff'), toneMapped: false })
    );
    this.barFill.position.set(0, -0.155, 0.002);
    this.group.add(this.barFill);

    this.redrawHeader();
    this.setLoadProgress(-1, '');
  }

  // -------------------------------------------------------------- drawing

  private redrawHeader(): void {
    const ctx = this.headerCtx;
    const W = this.headerCanvas.width;
    const H = this.headerCanvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(13,19,34,0.0)';
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#8fa0c2';
    ctx.font = '600 34px Inter, system-ui, sans-serif';
    ctx.fillText('MODEL', 24, 38);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 52px Inter, system-ui, sans-serif';
    const name = this.modelName.length > 26 ? this.modelName.slice(0, 25) + '…' : this.modelName;
    ctx.fillText(name, 24, 96);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#8fa0c2';
    ctx.font = '600 32px Inter, system-ui, sans-serif';
    ctx.fillText(this.modelCount, W - 24, 38);
    ctx.fillStyle = '#22d3ee';
    ctx.font = '700 34px Inter, system-ui, sans-serif';
    ctx.fillText(this.scaleText, W - 24, 96);
    ctx.fillStyle = '#8fa0c2';
    ctx.font = '500 30px Inter, system-ui, sans-serif';
    ctx.fillText('💡 ' + this.lightText, W - 24, 136);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#5b8cff';
    ctx.font = '600 30px Inter, system-ui, sans-serif';
    ctx.fillText('◉ trigger = press · grip-drag = move · 2-hand = scale', 24, 136);
    this.headerTexture.needsUpdate = true;
  }

  private drawButton(btn: HudButton, hover: boolean): void {
    const { ctx, canvas } = btn;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    if (hover) {
      grad.addColorStop(0, '#2b3d6e');
      grad.addColorStop(1, '#1c2a52');
    } else {
      grad.addColorStop(0, '#1b2540');
      grad.addColorStop(1, '#131b31');
    }
    ctx.fillStyle = grad;
    roundRect(ctx, 4, 4, W - 8, H - 8, 22);
    ctx.fill();
    ctx.lineWidth = hover ? 6 : 3;
    ctx.strokeStyle = hover ? '#22d3ee' : 'rgba(91,140,255,0.65)';
    roundRect(ctx, 4, 4, W - 8, H - 8, 22);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 34px Inter, system-ui, sans-serif';
    ctx.fillText(btn.label, W / 2, H / 2 - 16);
    ctx.fillStyle = hover ? '#22d3ee' : '#8fa0c2';
    ctx.font = '500 24px Inter, system-ui, sans-serif';
    ctx.fillText(btn.sub, W / 2, H / 2 + 26);
    btn.texture.needsUpdate = true;
  }

  // ------------------------------------------------------------------ API

  get interactive(): THREE.Object3D[] {
    return this.buttons.map((b) => b.mesh);
  }

  get follow(): boolean {
    return this.followEnabled;
  }

  setFollow(v: boolean): void {
    this.followEnabled = v;
    const btn = this.buttons.find((b) => b.action === 'follow');
    if (btn) {
      btn.sub = v ? 'ON' : 'on/off';
      this.drawButton(btn, this.hovered === btn.mesh);
    }
  }

  setModel(name: string, index: number, total: number): void {
    this.modelName = name;
    this.modelCount = `${index + 1} / ${total}`;
    this.redrawHeader();
  }

  setScale(normalized: number): void {
    this.scaleText = `${Math.round(normalized * 100)}%`;
    this.redrawHeader();
  }

  setLight(label: string): void {
    this.lightText = label;
    this.redrawHeader();
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  /** 0..1 shows the bar, -1 hides it. */
  setLoadProgress(p: number, label: string): void {
    this.loadProgress = p;
    const show = p >= 0;
    this.barBg.visible = show;
    this.barFill.visible = show;
    this.barLabel.visible = show;
    if (!show) return;
    const clamped = THREE.MathUtils.clamp(p, 0, 1);
    const fullW = 0.66;
    const fillW = Math.max(0.001, fullW * clamped);
    this.barFill.scale.set(fillW, 0.02, 1);
    this.barFill.position.x = -fullW / 2 + fillW / 2;
    (this.barFill.material as THREE.MeshBasicMaterial).color.set(clamped >= 1 ? '#34d399' : '#5b8cff');
    const ctx = this.barLabelCtx;
    ctx.clearRect(0, 0, this.barLabelCanvas.width, this.barLabelCanvas.height);
    ctx.fillStyle = '#c7d2e8';
    ctx.font = '500 34px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const txt = label ? `${label} — ${Math.round(clamped * 100)}%` : `${Math.round(clamped * 100)}%`;
    ctx.fillText(txt, this.barLabelCanvas.width / 2, 32);
    this.barLabelTexture.needsUpdate = true;
  }

  setHover(obj: THREE.Object3D | null): void {
    if (obj === this.hovered) return;
    this.hovered = obj;
    for (const b of this.buttons) this.drawButton(b, b.mesh === obj);
  }

  /** Map a raycast hit object back to its action (or null). */
  actionFor(obj: THREE.Object3D | null): SpatialAction | null {
    if (!obj) return null;
    let o: THREE.Object3D | null = obj;
    while (o) {
      const a = (o.userData as { spatialAction?: SpatialAction }).spatialAction;
      if (a) return a;
      o = o.parent;
    }
    return null;
  }

  emit(action: SpatialAction): void {
    this.onAction(action);
  }

  /**
   * Place the HUD on a comfort-level arc in front of the viewer.
   * Called on sessionstart and on Recenter: strictly explicit, no drift.
   */
  placeInFrontOf(camera: THREE.Object3D, distance = 0.9, height = 1.4): void {
    const camPos = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    camera.getWorldPosition(camPos);
    camera.getWorldDirection(camDir);
    camDir.y = 0;
    if (camDir.lengthSq() < 1e-6) camDir.set(0, 0, -1);
    camDir.normalize();
    const target = camPos.clone().addScaledVector(camDir, distance);
    target.y = height;
    this.group.position.copy(target);
    // Face the user (yaw only — no tilt drift)
    const look = camPos.clone();
    look.y = target.y;
    this.group.lookAt(look);
  }

  /** Per-frame: gentle yaw billboard only when follow is on. */
  update(_dt: number, camera: THREE.Object3D): void {
    if (!this.group.visible || !this.followEnabled) return;
    const hud = this.group.position;
    const cam = new THREE.Vector3();
    camera.getWorldPosition(cam);
    const dx = cam.x - hud.x;
    const dz = cam.z - hud.z;
    if (dx * dx + dz * dz < 1e-8) return;
    // Smoothly ease yaw toward the user — position itself never drifts.
    const yaw = Math.atan2(dx, dz);
    const e = new THREE.Euler().setFromQuaternion(this.group.quaternion, 'YXZ');
    let diff = yaw - e.y;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    e.y += diff * 0.08;
    e.x = 0;
    e.z = 0;
    this.group.quaternion.setFromEuler(e);
  }
}
