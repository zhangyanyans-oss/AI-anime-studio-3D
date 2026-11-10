// ============================================================
// 3D 导演台：把平面调度图 plot JSON 渲染成 3D 场景
// - 人物=彩色胶囊（含朝向鼻锥）、道具=方块、机位=机身+视锥扇面
// - 左键拖拽人物/道具/机位/轨迹拐点/朝向手柄 → 实时改 plot 副本
//   → 松手回调 onCommit(plotCopy)（由经典脚本 POST 后端重绘图纸）
// - 右下角「机位预览」第二视口：从机位按 facing/fov 实时渲染成片构图
// - 数据模型与 2D 完全同源：x,y ∈ 0-1，facing 角度（0=图纸上方，顺时针）
// ============================================================
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const WORLD = 10;                 // 0-1 归一化坐标 → 10x10 米的世界
const EYE = 1.6;                  // 机位预览视点高度（米）
const instances = new Map();      // key -> instance

const toWorldX = nx => (nx - 0.5) * WORLD;
const toWorldZ = ny => (ny - 0.5) * WORLD;
const toNormX = wx => Math.min(1, Math.max(0, wx / WORLD + 0.5));
const toNormZ = wz => Math.min(1, Math.max(0, wz / WORLD + 0.5));
// 必须放在模块顶层：applyDrag 是模块级函数，之前 clampW 被困在 open() 里，每次拖动都抛 ReferenceError，导致坐标永远更新不了
const clampW = v => Math.min(WORLD / 2, Math.max(-WORLD / 2, v));
const facingRad = deg => (deg || 0) * Math.PI / 180;          // 0=图纸上方(-z)，90=右(+x)
const facingDir = deg => new THREE.Vector3(Math.sin(facingRad(deg)), 0, -Math.cos(facingRad(deg)));

// ---------- 名字牌（canvas 贴图 sprite） ----------
function textSprite(text, color = "#f8fafc") {
    const fs = 44, pad = 14;
    const cv = document.createElement("canvas");
    let ctx = cv.getContext("2d");
    ctx.font = `600 ${fs}px -apple-system, sans-serif`;
    cv.width = Math.ceil(ctx.measureText(text).width) + pad * 2;
    cv.height = fs + pad * 2;
    ctx = cv.getContext("2d");
    ctx.font = `600 ${fs}px -apple-system, sans-serif`;
    ctx.fillStyle = "rgba(10, 16, 32, 0.78)";
    const r = 14, w = cv.width, h = cv.height;
    ctx.beginPath();
    ctx.moveTo(r, 0); ctx.arcTo(w, 0, w, h, r); ctx.arcTo(w, h, 0, h, r);
    ctx.arcTo(0, h, 0, 0, r); ctx.arcTo(0, 0, w, 0, r); ctx.closePath(); ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(text, pad, fs + pad - 6);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sp.scale.set(w / 110, h / 110, 1);
    sp.renderOrder = 20;
    return sp;
}

// ---------- 视锥扇面几何（贴地三角扇） ----------
function fanGeometry(camX, camZ, facingDeg, fovDeg, radius = 3.6) {
    const half = facingRad(fovDeg || 55) / 2, base = facingRad(facingDeg || 0);
    const verts = [camX, 0.04, camZ];
    const idx = [];
    const N = 24;
    for (let i = 0; i <= N; i++) {
        const a = base - half + (half * 2 * i) / N;
        verts.push(camX + Math.sin(a) * radius, 0.04, camZ - Math.cos(a) * radius);
        if (i < N) idx.push(0, i + 1, i + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    g.setIndex(idx);
    return g;
}

// ---------- 场景搭建 ----------
function buildScene(inst) {
    const { plot, palette } = inst;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0f172a");
    scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 1.15));
    const dl = new THREE.DirectionalLight(0xffffff, 1.1);
    dl.position.set(6, 10, 4);
    scene.add(dl);

    // 地面（layer0：机位预览也可见，提供地平线）
    const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(WORLD, WORLD),
        new THREE.MeshLambertMaterial({ color: "#26334d" })
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    // 网格/边框/辅助物（layer1：只在导演视角显示）
    const L1 = o => o.traverse(c => c.layers.set(1)) || o;
    const grid = new THREE.GridHelper(WORLD, 20, "#475569", "#334155");
    grid.position.y = 0.01;
    scene.add(L1(grid));
    const border = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(-WORLD / 2, 0.02, -WORLD / 2), new THREE.Vector3(WORLD / 2, 0.02, -WORLD / 2),
            new THREE.Vector3(WORLD / 2, 0.02, WORLD / 2), new THREE.Vector3(-WORLD / 2, 0.02, WORLD / 2),
        ]),
        new THREE.LineBasicMaterial({ color: "#64748b" })
    );
    scene.add(L1(border));

    inst.pickables = [];
    inst.charGroups = [];
    inst.pathLines = [];
    inst.dynamic = { fans: [], edges: [], targets: [] }; // 随 facing 重建的机位部件

    // ---------- 人物 ----------
    (plot.characters || []).forEach((c, ci) => {
        if (typeof c.x !== "number" || typeof c.y !== "number") return;
        const color = palette[ci % palette.length];
        const g = new THREE.Group();
        g.position.set(toWorldX(c.x), 0, toWorldZ(c.y));
        g.rotation.y = -facingRad(c.facing);
        const body = new THREE.Mesh(
            new THREE.CapsuleGeometry(0.34, 1.0, 4, 14),
            new THREE.MeshLambertMaterial({ color })
        );
        body.position.y = 0.84;
        body.userData.pick = { type: "char", idx: ci };
        const nose = new THREE.Mesh(
            new THREE.ConeGeometry(0.13, 0.34, 12),
            new THREE.MeshLambertMaterial({ color })
        );
        nose.rotation.x = Math.PI / 2;           // 锥尖朝 -z（即人物面向）
        nose.position.set(0, 0.95, -0.55);
        nose.userData.pick = { type: "charface", idx: ci };
        const name = textSprite(c.name || "?");
        name.position.y = 2.05;
        g.add(body, nose, name);
        scene.add(g);
        inst.charGroups[ci] = g;
        inst.pickables.push(body, nose);

        // 轨迹：起点(脚下)+拐点 折线 + 可拖拐点球
        const pts = [[c.x, c.y], ...(c.path || [])];
        if (pts.length > 1) {
            const lp = new THREE.Line(
                new THREE.BufferGeometry().setFromPoints(
                    pts.map(([x, y]) => new THREE.Vector3(toWorldX(x), 0.06, toWorldZ(y)))
                ),
                new THREE.LineBasicMaterial({ color })
            );
            scene.add(L1(lp));
            inst.pathLines.push({ type: "char", idx: ci, line: lp });
        }
        (c.path || []).forEach((pt, pi) => {
            if (typeof pt[0] !== "number") return;
            const s = new THREE.Mesh(
                new THREE.SphereGeometry(0.16, 12, 10),
                new THREE.MeshLambertMaterial({ color })
            );
            s.position.set(toWorldX(pt[0]), 0.16, toWorldZ(pt[1]));
            s.userData.pick = { type: "waypoint", ci, pi };
            scene.add(L1(s));
            inst.pickables.push(s);
        });
    });

    // ---------- 道具 ----------
    (plot.props || []).forEach((p, pi) => {
        if (typeof p.x !== "number" || typeof p.y !== "number") return;
        const w = Math.max((p.w || 0.1) * WORLD, 0.3), h = Math.max((p.h || 0.1) * WORLD, 0.3);
        const box = new THREE.Mesh(
            new THREE.BoxGeometry(w, 1.0, h),
            new THREE.MeshLambertMaterial({ color: "#7c8aa0", transparent: true, opacity: 0.92 })
        );
        box.position.set(toWorldX(p.x), 0.5, toWorldZ(p.y));
        box.userData.pick = { type: "prop", idx: pi };
        const label = textSprite(p.label || p.name || "道具", "#cbd5e1");
        label.position.y = 1.5;
        const g = new THREE.Group();
        g.add(box, label);
        g.position.copy(box.position);
        box.position.set(0, 0, 0);
        scene.add(g);
        inst.propGroups = inst.propGroups || [];
        inst.propGroups[pi] = g;
        inst.pickables.push(box);
    });

    // ---------- 机位 ----------
    const cam = plot.camera;
    if (cam && typeof cam.x === "number") {
        const cg = new THREE.Group();
        cg.position.set(toWorldX(cam.x), 0, toWorldZ(cam.y));
        const body = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 0.36, 0.72),
            new THREE.MeshLambertMaterial({ color: "#111827" })
        );
        body.position.y = 0.5;
        body.userData.pick = { type: "camera" };
        const lens = new THREE.Mesh(
            new THREE.CylinderGeometry(0.09, 0.12, 0.22, 12),
            new THREE.MeshLambertMaterial({ color: "#374151" })
        );
        lens.rotation.x = Math.PI / 2;
        lens.position.set(0, 0.5, -0.45);
        lens.userData.pick = { type: "camera" };
        const camLabel = textSprite("机位", "#fca5a5");
        camLabel.position.y = 1.35;
        cg.add(body, lens, camLabel);
        cg.rotation.y = -facingRad(cam.facing);
        scene.add(cg);
        inst.camGroup = cg;
        inst.pickables.push(body, lens);
        // 机位运动轨迹
        (cam.path || []).forEach((pt, pi) => {
            if (typeof pt[0] !== "number") return;
            const s = new THREE.Mesh(
                new THREE.SphereGeometry(0.16, 12, 10),
                new THREE.MeshLambertMaterial({ color: "#ef4444" })
            );
            s.position.set(toWorldX(pt[0]), 0.16, toWorldZ(pt[1]));
            s.userData.pick = { type: "camway", pi };
            scene.add(L1(s));
            inst.pickables.push(s);
        });
        if ((cam.path || []).length) {
            const lp = new THREE.Line(
                new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(toWorldX(cam.x), 0.06, toWorldZ(cam.y)),
                    ...(cam.path || []).map(([x, y]) => new THREE.Vector3(toWorldX(x), 0.06, toWorldZ(y))),
                ]),
                new THREE.LineBasicMaterial({ color: "#ef4444" })
            );
            scene.add(L1(lp));
            inst.pathLines.push({ type: "camera", line: lp });
        }
    }
    return scene;
}

// ---------- 机位朝向/fov 相关部件重建 ----------
function rebuildCamFacing(inst) {
    const cam = inst.plot.camera;
    if (!inst.camGroup || !cam) return;
    inst.camGroup.rotation.y = -facingRad(cam.facing);
    // 清掉旧扇面/边线/朝向手柄
    inst.dynamic.fans.forEach(m => { m.geometry.dispose(); inst.scene.remove(m); });
    inst.dynamic.edges.forEach(m => { m.geometry.dispose(); inst.scene.remove(m); });
    inst.dynamic.targets.forEach(m => { m.geometry.dispose(); inst.scene.remove(m); });
    inst.dynamic = { fans: [], edges: [], targets: [] };
    const wx = inst.camGroup.position.x, wz = inst.camGroup.position.z;
    const fan = new THREE.Mesh(
        fanGeometry(wx, wz, cam.facing, cam.fov),
        new THREE.MeshBasicMaterial({ color: "#ef4444", transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false })
    );
    const dir = facingDir(cam.facing);
    // 扇面两条边线
    [-(cam.fov || 55) / 2, (cam.fov || 55) / 2].forEach(off => {
        const a = facingRad(cam.facing) + facingRad(off);
        const line = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(wx, 0.05, wz),
                new THREE.Vector3(wx + Math.sin(a) * 3.6, 0.05, wz - Math.cos(a) * 3.6),
            ]),
            new THREE.LineBasicMaterial({ color: "#f87171" })
        );
        inst.scene.add(line);
        inst.dynamic.edges.push(line);
    });
    // 朝向手柄（拖它转机位朝向）
    const t = new THREE.Mesh(
        new THREE.SphereGeometry(0.2, 14, 12),
        new THREE.MeshBasicMaterial({ color: "#ef4444" })
    );
    t.position.set(wx + dir.x * 1.5, 0.22, wz + dir.z * 1.5);
    t.userData.pick = { type: "camface" };
    inst.scene.add(t);
    inst.dynamic.targets.push(t);
    inst.pickables = inst.pickables.filter(p => p.userData.pick.type !== "camface");
    inst.pickables.push(t);
    inst.scene.add(fan);
    inst.dynamic.fans.push(fan);
}

// ---------- 实例生命周期 ----------
function dispose(inst) {
    if (!inst) return;
    inst.dead = true;
    if (inst.raf) cancelAnimationFrame(inst.raf);
    if (inst.ro) inst.ro.disconnect();
    try { inst.controls && inst.controls.dispose(); } catch (_) {}
    if (inst.renderer) {
        inst.renderer.dispose();
        inst.renderer.domElement && inst.renderer.domElement.remove();
    }
    if (inst.scene) inst.scene.traverse(o => {
        o.geometry && o.geometry.dispose && o.geometry.dispose();
        const m = o.material;
        if (m) { (Array.isArray(m) ? m : [m]).forEach(mm => { mm.map && mm.map.dispose && mm.map.dispose(); mm.dispose && mm.dispose(); }); }
    });
    instances.delete(inst.key);
}

function closeAll() {
    [...instances.values()].forEach(dispose);
}

function open(key, container, plot, palette, onCommit) {
    const prev = instances.get(key);
    if (prev) {
        // 已开着：plot 没变就不动（避免重渲染闪烁），变了就重建
        const sig = JSON.stringify(plot);
        if (prev.sig === sig) return;
        dispose(prev);
    }
    closeAll(); // 全场只保留一个 3D 导演台

    const inst = {
        key, container, palette, onCommit,
        plot: JSON.parse(JSON.stringify(plot || {})),
        sig: JSON.stringify(plot),
    };
    instances.set(key, inst);

    container.innerHTML = `
        <div class="dir3d-wrap" style="position:relative; height:min(72vh, 760px); border:1px solid var(--border-color); border-radius:10px; overflow:hidden; background:#0f172a;">
            <div class="dir3d-hint" style="position:absolute; top:8px; left:10px; z-index:3; font-size:12px; color:#94a3b8; background:rgba(10,16,32,.72); padding:4px 10px; border-radius:8px; pointer-events:none;">
                🖱️ 左键拖人物/机位/道具/红点（松手重绘图纸）· 右键平移 · 滚轮缩放 · 空白处左键旋转视角
            </div>
            <button class="dir3d-pvbtn" title="开关右下角的机位预览窗，挡住场景时可关掉" style="position:absolute; top:8px; right:10px; z-index:4; font-size:12px; color:#e2e8f0; background:rgba(10,16,32,.72); border:1px solid rgba(148,163,184,.45); padding:4px 10px; border-radius:8px; cursor:pointer;">🎥 预览窗：开</button>
            <div class="dir3d-camlabel" style="position:absolute; right:14px; bottom:14px; z-index:3; font-size:12px; color:#fca5a5; background:rgba(10,16,32,.72); padding:3px 9px; border-radius:8px; pointer-events:none;">🎥 机位预览（成片构图）</div>
        </div>`;
    const wrap = container.firstElementChild;
    inst.showPreview = true;
    wrap.querySelector(".dir3d-pvbtn").addEventListener("click", () => {
        inst.showPreview = !inst.showPreview;
        wrap.querySelector(".dir3d-pvbtn").textContent = inst.showPreview ? "🎥 预览窗：开" : "🎥 预览窗：关";
        resize();
    });

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.autoClear = false;
    renderer.domElement.style.cssText = "width:100%; height:100%; display:block; touch-action:none;";
    wrap.appendChild(renderer.domElement);
    inst.renderer = renderer;

    const scene = buildScene(inst);
    inst.scene = scene;

    // 导演视角主相机
    const mainCam = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
    mainCam.position.set(0, 12.5, 12.5);
    mainCam.lookAt(0, 0, 0);
    mainCam.layers.enable(1);
    inst.mainCam = mainCam;

    // 机位预览相机（只看 layer0）
    const pvCam = new THREE.PerspectiveCamera(plot.camera?.fov || 55, 16 / 9, 0.1, 200);
    inst.pvCam = pvCam;

    rebuildCamFacing(inst);

    // ---------- 交互：射线拾取拖拽 ----------
    // 注意：必须先于 OrbitControls 注册——同一元素上的监听按注册顺序触发，
    // 这样命中可拖物体时我们先把 controls.enabled=false，OrbitControls 才不会同时转视角
    const raycaster = new THREE.Raycaster();
    raycaster.layers.enable(1);   // 轨迹拐点/机位轨迹红点在 layer1（仅导演视角显示），不开启就永远点不到
    const pointer = new THREE.Vector2();
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    let drag = null;
    const dom = renderer.domElement;

    const setPointer = e => {
        const r = dom.getBoundingClientRect();
        pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
        pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    };
    const groundPoint = e => {
        setPointer(e);
        raycaster.setFromCamera(pointer, mainCam);
        const v = new THREE.Vector3();
        return raycaster.ray.intersectPlane(groundPlane, v) ? v : null;
    };

    dom.addEventListener("pointerdown", e => {
        if (e.button !== 0) return; // 右/中键留给视角控制
        // 预览窗区域不参与拾取：那里画的是机位视角，若按主视角射线去抓，
        // 会抓到"被预览窗挡住的主视图物体"，出现看着 A 拖着 B 的错乱体验
        {
            const r = dom.getBoundingClientRect();
            const px = e.clientX - r.left, py = e.clientY - r.top;
            const [pw, ph] = pvWH();
            if (pw > 40 && px >= (inst.viewW || 0) - pw - 10 && py >= (inst.viewH || 0) - ph - 10) return;
        }
        setPointer(e);
        raycaster.setFromCamera(pointer, mainCam);
        const hits = raycaster.intersectObjects(inst.pickables, false);
        if (!hits.length) return;
        const hitObj = hits[0].object;
        const pk = hitObj.userData.pick;
        const gp = groundPoint(e) || hits[0].point;
        drag = { pk, moved: false, start: { x: e.clientX, y: e.clientY } };
        // 拖拽偏移：抓住物体的点到其地面锚点的差，避免拖动瞬跳
        const anchor = pickAnchor(inst, pk);
        if (anchor) drag.off = { x: gp.x - anchor.x, z: gp.z - anchor.z };
        controls.enabled = false;
        dom.setPointerCapture && dom.setPointerCapture(e.pointerId);
        e.preventDefault();
        e.stopPropagation();
    }, true);
    dom.addEventListener("pointermove", e => {
        if (!drag) return;
        if (Math.abs(e.clientX - drag.start.x) + Math.abs(e.clientY - drag.start.y) > 3) drag.moved = true;
        const gp = groundPoint(e);
        if (!gp) return;
        applyDrag(inst, drag.pk, gp, drag.off || { x: 0, z: 0 });
    }, true);
    const endDrag = () => {
        if (!drag) return;
        const moved = drag.moved;
        const plotCopy = moved ? JSON.parse(JSON.stringify(inst.plot)) : null;
        drag = null;
        controls.enabled = true;
        if (moved && inst.onCommit) inst.onCommit(plotCopy);
    };
    dom.addEventListener("pointerup", endDrag, true);
    dom.addEventListener("pointercancel", endDrag, true);

    // 视角控制（注册在拖拽监听之后，见上）
    const controls = new OrbitControls(mainCam, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = 1.5;
    controls.minDistance = 3;
    controls.maxDistance = 45;
    inst.controls = controls;

    // ---------- 尺寸自适应 + 渲染循环 ----------
    // 预览窗固定 16:9、宽 30%（可开关），标签贴在预览窗上沿
    const PV_RATIO = 0.30;
    const pvWH = () => {
        const w = inst.viewW || 0;
        const pw = inst.showPreview ? Math.round(w * PV_RATIO) : 0;
        return [pw, Math.round(pw * 9 / 16)];
    };
    const resize = () => {
        const w = wrap.clientWidth, h = wrap.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h, false);
        mainCam.aspect = w / h;
        mainCam.updateProjectionMatrix();
        inst.viewW = w; inst.viewH = h;
        const [pw, ph] = pvWH();
        const label = wrap.querySelector(".dir3d-camlabel");
        if (label) {
            label.style.display = pw > 40 ? "" : "none";
            label.style.bottom = (ph + 22) + "px";
        }
    };
    inst.ro = new ResizeObserver(resize);
    inst.ro.observe(wrap);
    resize();

    const render = () => {
        if (inst.dead || !inst.container.isConnected) { dispose(inst); return; }
        controls.update();
        // 机位预览相机实时跟随 plot.camera（可在右上角按钮关闭）
        const cam = inst.plot.camera;
        const w = inst.viewW || 1, h = inst.viewH || 1;
        const [pw, ph] = pvWH();
        if (cam && typeof cam.x === "number") {
            pvCam.fov = cam.fov || 55;
            pvCam.updateProjectionMatrix();
            pvCam.position.set(toWorldX(cam.x), EYE, toWorldZ(cam.y));
            const d = facingDir(cam.facing);
            pvCam.lookAt(pvCam.position.x + d.x, pvCam.position.y - 0.35, pvCam.position.z + d.z);
        }
        const renderer2 = inst.renderer;
        renderer2.setScissorTest(true);
        renderer2.setViewport(0, 0, w, h);
        renderer2.setScissor(0, 0, w, h);
        renderer2.clear(true, true, false);
        renderer2.render(scene, mainCam);
        if (cam && typeof cam.x === "number" && pw > 40) {
            renderer2.clearDepth();
            renderer2.setViewport(w - pw - 10, 10, pw, ph);
            renderer2.setScissor(w - pw - 10, 10, pw, ph);
            renderer2.render(scene, pvCam);
        }
        inst.raf = requestAnimationFrame(render);
    };
    render();
}

function pickAnchor(inst, pk) {
    if (pk.type === "char" || pk.type === "charface") {
        const c = (inst.plot.characters || [])[pk.idx];
        const g = inst.charGroups[pk.idx];
        return c && g ? { x: g.position.x, z: g.position.z } : null;
    }
    if (pk.type === "prop") {
        const g = (inst.propGroups || [])[pk.idx];
        return g ? { x: g.position.x, z: g.position.z } : null;
    }
    if (pk.type === "camera" || pk.type === "camface") {
        const g = inst.camGroup;
        return g ? { x: g.position.x, z: g.position.z } : null;
    }
    return null;
}

// 把地面拾取点应用到 plot 副本与 3D 物体（拖拽中的实时反馈）
function applyDrag(inst, pk, gp, off) {
    const wx = clampW(gp.x - off.x), wz = clampW(gp.z - off.z);
    const nx = toNormX(wx), ny = toNormZ(wz);

    if (pk.type === "char") {
        const c = (inst.plot.characters || [])[pk.idx]; if (!c) return;
        const g = inst.charGroups[pk.idx]; if (!g) return;
        const dx = nx - c.x, dy = ny - c.y;
        c.x = nx; c.y = ny;
        (c.path || []).forEach(pt => { pt[0] = Math.min(1, Math.max(0, pt[0] + dx)); pt[1] = Math.min(1, Math.max(0, pt[1] + dy)); });
        g.position.set(toWorldX(c.x), 0, toWorldZ(c.y));
        // 轨迹线与拐点球跟着平移（世界坐标等差）
        (c.path || []).forEach((pt, pi) => {
            const s = inst.pickables.find(p => p.userData.pick.type === "waypoint" && p.userData.pick.ci === pk.idx && p.userData.pick.pi === pi);
            if (s) s.position.set(toWorldX(pt[0]), 0.16, toWorldZ(pt[1]));
        });
        inst.pathLines.filter(l => l.type === "char" && l.idx === pk.idx).forEach(l => {
            const c2 = inst.plot.characters[pk.idx];
            l.line.geometry.setFromPoints([[c2.x, c2.y], ...(c2.path || [])].map(([x, y]) => new THREE.Vector3(toWorldX(x), 0.06, toWorldZ(y))));
        });
    } else if (pk.type === "charface") {
        const c = (inst.plot.characters || [])[pk.idx]; if (!c) return;
        const g = inst.charGroups[pk.idx]; if (!g) return;
        const dx = wx - g.position.x, dz = wz - g.position.z;
        if (Math.hypot(dx, dz) < 0.05) return;
        let deg = Math.atan2(dx, -dz) * 180 / Math.PI;   // 0=-z 上方，顺时针为正
        deg = Math.round(((deg % 360) + 360) % 360);
        c.facing = deg;
        g.rotation.y = -facingRad(deg);
    } else if (pk.type === "waypoint") {
        const c = (inst.plot.characters || [])[pk.ci]; if (!c) return;
        const pt = (c.path || [])[pk.pi]; if (!pt) return;
        pt[0] = nx; pt[1] = ny;
        const s = inst.pickables.find(p => p.userData.pick.type === "waypoint" && p.userData.pick.ci === pk.ci && p.userData.pick.pi === pk.pi);
        if (s) s.position.set(wx, 0.16, wz);
        inst.pathLines.filter(l => l.type === "char" && l.idx === pk.ci).forEach(l => {
            l.line.geometry.setFromPoints([[c.x, c.y], ...(c.path || [])].map(([x, y]) => new THREE.Vector3(toWorldX(x), 0.06, toWorldZ(y))));
        });
    } else if (pk.type === "prop") {
        const p = (inst.plot.props || [])[pk.idx]; if (!p) return;
        const g = (inst.propGroups || [])[pk.idx]; if (!g) return;
        p.x = nx; p.y = ny;
        g.position.set(wx, 0.5, wz);
    } else if (pk.type === "camera") {
        const cam = inst.plot.camera; if (!cam) return;
        const dx = nx - cam.x, dy = ny - cam.y;
        cam.x = nx; cam.y = ny;
        (cam.path || []).forEach(pt => { pt[0] = Math.min(1, Math.max(0, pt[0] + dx)); pt[1] = Math.min(1, Math.max(0, pt[1] + dy)); });
        inst.camGroup.position.set(toWorldX(cam.x), 0, toWorldZ(cam.y));
        (cam.path || []).forEach((pt, pi) => {
            const s = inst.pickables.find(p => p.userData.pick.type === "camway" && p.userData.pick.pi === pi);
            if (s) s.position.set(toWorldX(pt[0]), 0.16, toWorldZ(pt[1]));
        });
        inst.pathLines.filter(l => l.type === "camera").forEach(l => {
            l.line.geometry.setFromPoints([
                new THREE.Vector3(toWorldX(cam.x), 0.06, toWorldZ(cam.y)),
                ...(cam.path || []).map(([x, y]) => new THREE.Vector3(toWorldX(x), 0.06, toWorldZ(y))),
            ]);
        });
        rebuildCamFacing(inst);
    } else if (pk.type === "camface") {
        const cam = inst.plot.camera; if (!cam || !inst.camGroup) return;
        const dx = wx - inst.camGroup.position.x, dz = wz - inst.camGroup.position.z;
        if (Math.hypot(dx, dz) < 0.05) return;
        cam.facing = Math.round(((Math.atan2(dx, -dz) * 180 / Math.PI % 360) + 360) % 360);
        rebuildCamFacing(inst);
    } else if (pk.type === "camway") {
        const cam = inst.plot.camera; if (!cam) return;
        const pt = (cam.path || [])[pk.pi]; if (!pt) return;
        pt[0] = nx; pt[1] = ny;
        const s = inst.pickables.find(p => p.userData.pick.type === "camway" && p.userData.pick.pi === pk.pi);
        if (s) s.position.set(wx, 0.16, wz);
        inst.pathLines.filter(l => l.type === "camera").forEach(l => {
            l.line.geometry.setFromPoints([
                new THREE.Vector3(toWorldX(cam.x), 0.06, toWorldZ(cam.y)),
                ...(cam.path || []).map(([x, y]) => new THREE.Vector3(toWorldX(x), 0.06, toWorldZ(y))),
            ]);
        });
    }
}

// ---------- 对外 API ----------
window.Director3D = {
    open, dispose,
    isOpen: key => instances.has(key),
    closeAll,
};
window.dispatchEvent(new Event("director3d-ready"));
