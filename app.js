// GPCR Tree scroll animation + labeler.
//
// Pipeline:
//   1. Inspect every <path> in the inlined SVG, measure length and endpoints.
//   2. Order paths by their distance from a single root (the existing center
//      dot in the SVG) so the tree appears to grow outward from the trunk.
//   3. Map global scroll progress (0..1) onto each path's animation window
//      via stroke-dasharray / stroke-dashoffset.
//   4. After most of the tree is drawn, fade in named "tip" highlights
//      defined in TIPS_CONFIG (or loaded from localStorage in labeler mode).

// ---------------------------------------------------------------- config ---

// The little dot at line 363 of GPCR_tree_noNames.svg sits at (384.249, 351.062)
// and is clearly the trunk root, so we anchor "growth from center" there.
const ROOT = { x: 384.249, y: 351.062 };

// Fraction of total scroll devoted to growing the tree (rest = highlights).
const GROW_RANGE = [0.0, 0.78];
const HIGHLIGHT_RANGE = [0.78, 1.0];

// How aggressively branches overlap in time. Lower = more sequential.
const BRANCH_DURATION = 0.18;

// Tips configuration. The labeler mode lets you build this interactively
// and export it as JSON. You can also paste a hardcoded list here.
//
// Each entry: { name: "ADRB1", x: 690, y: 178, color?: "#ff5d8f" }
const DEFAULT_TIPS = [];

// ----------------------------------------------------------------- state ---

const DEFAULT_COLORS = {
  tree: "#e6e9ef",
  tip: "#ff5d8f",
  label: "#e6e9ef",
  bg: "#0b0d12",
};

const state = {
  paths: [],          // [{el, len, start, end, distFromRoot, t0, t1, isFill}]
  maxReach: 1,
  tips: [],           // [{name, x, y, color, el, ringEl, lineEl, textEl}]
  candidatePoints: [], // every distinct path endpoint, used by labeler
  labelMode: false,
  pendingTip: null,   // { x, y, editIndex? } when the labeler dialog is open
  colors: { ...DEFAULT_COLORS },
};

// --------------------------------------------------------------- helpers ---

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// --------------------------------------------------- path utilities ------
//
// We need every path to be drawn FROM the vertex closest to the trunk root
// OUTWARD, so the dasharray animation visually flows "from the parent
// branch toward the leaf". The source SVG often goes the other way (its
// `M` is on the leaf side), and a few paths even pivot through a junction
// in the middle. To handle both we:
//
//   1. Tokenize the `d` attribute (only M/L/H/V/C/Z appear in this file).
//   2. Build a flat list of vertices (one per L/C/H/V endpoint).
//   3. Find the vertex closest to the root.
//   4. If that vertex is the start: leave the path alone.
//      If it's the end: reverse the whole path so the M lives on it.
//      If it's in the middle: split the path in two at that vertex,
//      reversing the first half so both halves grow outward from the
//      shared junction.

function parsePathCommands(d) {
  const out = [];
  const re = /([MLHVCZ])([^MLHVCZ]*)/gi;
  let m;
  while ((m = re.exec(d)) !== null) {
    const cmd = m[1].toUpperCase();
    const args = m[2]
      .trim()
      .split(/[\s,]+/)
      .filter((s) => s.length > 0)
      .map(Number);
    out.push({ cmd, args });
  }
  return out;
}

function commandsToVertices(commands) {
  // verts[0] is the M; verts[i>0].seg describes how to GO FROM verts[i-1]
  // TO verts[i] (either 'L' or 'C').
  const verts = [];
  let cx = 0, cy = 0;
  let startX = 0, startY = 0;
  for (const { cmd, args } of commands) {
    switch (cmd) {
      case "M":
        for (let i = 0; i < args.length; i += 2) {
          cx = args[i];
          cy = args[i + 1];
          if (i === 0) {
            verts.push({ x: cx, y: cy, seg: "M" });
            startX = cx;
            startY = cy;
          } else {
            // Extra pairs after the first M coordinate are implicit lineto.
            verts.push({ x: cx, y: cy, seg: "L" });
          }
        }
        break;
      case "L":
        for (let i = 0; i < args.length; i += 2) {
          cx = args[i];
          cy = args[i + 1];
          verts.push({ x: cx, y: cy, seg: "L" });
        }
        break;
      case "H":
        for (let i = 0; i < args.length; i++) {
          cx = args[i];
          verts.push({ x: cx, y: cy, seg: "L" });
        }
        break;
      case "V":
        for (let i = 0; i < args.length; i++) {
          cy = args[i];
          verts.push({ x: cx, y: cy, seg: "L" });
        }
        break;
      case "C":
        for (let i = 0; i < args.length; i += 6) {
          const cp1x = args[i],     cp1y = args[i + 1];
          const cp2x = args[i + 2], cp2y = args[i + 3];
          const x    = args[i + 4], y    = args[i + 5];
          verts.push({ x, y, seg: "C", cp1x, cp1y, cp2x, cp2y });
          cx = x;
          cy = y;
        }
        break;
      case "Z":
        if (verts.length > 0 && (cx !== startX || cy !== startY)) {
          verts.push({ x: startX, y: startY, seg: "L" });
        }
        cx = startX;
        cy = startY;
        break;
    }
  }
  return verts;
}

function verticesToPathD(verts) {
  if (verts.length === 0) return "";
  const out = [`M${verts[0].x} ${verts[0].y}`];
  for (let i = 1; i < verts.length; i++) {
    const v = verts[i];
    if (v.seg === "C") {
      out.push(`C${v.cp1x} ${v.cp1y} ${v.cp2x} ${v.cp2y} ${v.x} ${v.y}`);
    } else {
      out.push(`L${v.x} ${v.y}`);
    }
  }
  return out.join("");
}

function reverseVertices(verts) {
  if (verts.length < 2) return verts.slice();
  const last = verts[verts.length - 1];
  const out = [{ x: last.x, y: last.y, seg: "M" }];
  for (let i = verts.length - 1; i > 0; i--) {
    const cur = verts[i];
    const prev = verts[i - 1];
    if (cur.seg === "C") {
      // For a reversed cubic Bezier, swap the two control points and
      // make the previous endpoint the new target.
      out.push({
        x: prev.x, y: prev.y, seg: "C",
        cp1x: cur.cp2x, cp1y: cur.cp2y,
        cp2x: cur.cp1x, cp2y: cur.cp1y,
      });
    } else {
      out.push({ x: prev.x, y: prev.y, seg: "L" });
    }
  }
  return out;
}

function findClosestVertexIdx(verts, rootX, rootY) {
  let minD = Infinity;
  let minI = 0;
  for (let i = 0; i < verts.length; i++) {
    const d = Math.hypot(verts[i].x - rootX, verts[i].y - rootY);
    if (d < minD) {
      minD = d;
      minI = i;
    }
  }
  return { idx: minI, dist: minD };
}

// Take one DOM <path> element and return one or two normalized children.
// Each returned entry is { el } where el's `d` has been rewritten so the
// first point is the closest-to-root vertex of that segment.
function normalizeAndSplitPath(el) {
  const d = el.getAttribute("d");
  if (!d) return [{ el }];

  const verts = commandsToVertices(parsePathCommands(d));
  if (verts.length < 2) return [{ el }];

  const { idx } = findClosestVertexIdx(verts, ROOT.x, ROOT.y);

  // Already grows outward from the closest vertex.
  if (idx === 0) {
    return [{ el }];
  }

  // Grows entirely inward — reverse it in place.
  if (idx === verts.length - 1) {
    el.setAttribute("d", verticesToPathD(reverseVertices(verts)));
    return [{ el }];
  }

  // V-shaped: closest vertex is in the middle. Split at it.
  const firstHalf = verts.slice(0, idx + 1);   // [v0..vIdx]
  const secondHalf = verts.slice(idx);         // [vIdx..vEnd]
  // First half reversed so it grows from vIdx outward to v0.
  const firstD = verticesToPathD(reverseVertices(firstHalf));
  // Second half just needs vIdx to be treated as M; verticesToPathD
  // already writes verts[0] as M regardless of its stored seg.
  const secondD = verticesToPathD(secondHalf);

  // Mutate the original element to be the first half, clone for second.
  el.setAttribute("d", firstD);
  const clone = el.cloneNode(false);
  clone.setAttribute("d", secondD);
  el.parentNode.insertBefore(clone, el.nextSibling);

  return [{ el }, { el: clone }];
}

// --------------------------------------------------- prepare paths --------

function preparePaths(svg) {
  const original = Array.from(svg.querySelectorAll("path"));

  // Step 1: normalize and split so each path's M is closest to root.
  const normalized = [];
  for (const el of original) {
    const isFill =
      el.getAttribute("fill") === "black" && !el.getAttribute("stroke");
    for (const entry of normalizeAndSplitPath(el)) {
      normalized.push({ el: entry.el, isFill });
    }
  }

  // Step 2: measure each (now normalized) path.
  state.paths = normalized.map(({ el, isFill }) => {
    const len = Math.max(el.getTotalLength(), 0.0001);
    const start = el.getPointAtLength(0);
    const end = el.getPointAtLength(len);
    const distStart = dist(start.x, start.y, ROOT.x, ROOT.y);
    const distEnd = dist(end.x, end.y, ROOT.x, ROOT.y);
    // After normalization, the start is always the closest-to-root vertex,
    // so we can confidently use it as the spawn distance.
    const distFromRoot = distStart;

    if (!isFill) {
      el.style.strokeDasharray = `${len} ${len}`;
      el.style.strokeDashoffset = `${len}`;
    } else {
      el.style.opacity = "0";
    }
    return { el, len, start, end, distStart, distEnd, distFromRoot, isFill };
  });

  // Step 3: timing windows.
  state.maxReach = Math.max(
    1,
    ...state.paths.map((p) => p.distFromRoot + p.len)
  );
  for (const p of state.paths) {
    const norm = p.distFromRoot / state.maxReach;
    const lenWeight = Math.min(1, (p.len / state.maxReach) * 1.4);
    p.t0 = norm * (1 - BRANCH_DURATION);
    p.t1 = p.t0 + BRANCH_DURATION + lenWeight * 0.05;
    if (p.t1 > 1) p.t1 = 1;
  }

  // Step 4: candidate tip points for the labeler.
  const seen = new Map();
  for (const p of state.paths) {
    // After normalization, the FAR endpoint (`end`) is the leaf-side tip.
    const farPoint = p.end;
    if (Math.max(p.distStart, p.distEnd) < 30) continue;
    const key = `${Math.round(farPoint.x)}_${Math.round(farPoint.y)}`;
    if (!seen.has(key)) {
      seen.set(key, { x: farPoint.x, y: farPoint.y });
    }
  }
  state.candidatePoints = Array.from(seen.values());
}

// --------------------------------------------------- draw / scroll loop --

function applyProgress(progress) {
  // Phase 1: tree growth.
  const growT = smoothstep(GROW_RANGE[0], GROW_RANGE[1], progress);

  for (const p of state.paths) {
    const local = clamp01((growT - p.t0) / (p.t1 - p.t0));
    if (p.isFill) {
      p.el.style.opacity = local > 0.85 ? "1" : "0";
    } else {
      p.el.style.strokeDashoffset = `${p.len * (1 - local)}`;
    }
  }

  // Phase 2: highlight named tips.
  const hiT = smoothstep(HIGHLIGHT_RANGE[0], HIGHLIGHT_RANGE[1], progress);
  state.tips.forEach((tip, idx) => {
    if (!tip.dotEl) return;
    // Stagger the appearance across the highlight range.
    const stagger = state.tips.length > 1 ? idx / state.tips.length : 0;
    const appear = clamp01((hiT - stagger * 0.6) / 0.4);
    tip.dotEl.setAttribute("r", `${lerp(0, 7, appear)}`);
    tip.ringEl.setAttribute("r", `${lerp(0, 14, appear)}`);
    tip.ringEl.style.opacity = `${appear * 0.8}`;
    tip.lineEl.style.opacity = `${appear * 0.6}`;
    tip.textEl.style.opacity = `${appear}`;
  });
}

function getScrollProgress() {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  if (max <= 0) return 0;
  return clamp01(window.scrollY / max);
}

let frameRequested = false;
function onScroll() {
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(() => {
    frameRequested = false;
    const p = getScrollProgress();
    applyProgress(p);
    document.querySelector(".progress-bar").style.width = `${p * 100}%`;
  });
}

// ----------------------------------------------------- highlight overlay --

function buildHighlightOverlay(svg, tips) {
  // Create one <g> per tip with: dot, ring, leader line, text label.
  const overlay = document.createElementNS("http://www.w3.org/2000/svg", "g");
  overlay.setAttribute("id", "highlight-overlay");
  svg.appendChild(overlay);

  state.tips = tips.map((t) => {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const color = t.color || state.colors.tip;

    // Leader line out to label.
    const labelOffset = pickLabelOffset(t.x, t.y);
    const lx = t.x + labelOffset.dx;
    const ly = t.y + labelOffset.dy;

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", t.x);
    line.setAttribute("y1", t.y);
    line.setAttribute("x2", lx);
    line.setAttribute("y2", ly);
    line.setAttribute("class", "label-line");
    line.style.stroke = color;
    line.style.opacity = "0";
    g.appendChild(line);

    const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    ring.setAttribute("cx", t.x);
    ring.setAttribute("cy", t.y);
    ring.setAttribute("r", "0");
    ring.setAttribute("class", "tip-highlight-ring");
    ring.style.stroke = color;
    g.appendChild(ring);

    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", t.x);
    dot.setAttribute("cy", t.y);
    dot.setAttribute("r", "0");
    dot.setAttribute("class", "tip-highlight");
    dot.style.fill = color;
    dot.style.filter = `drop-shadow(0 0 6px ${color})`;
    g.appendChild(dot);

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", lx + (labelOffset.dx >= 0 ? 6 : -6));
    text.setAttribute("y", ly + 4);
    text.setAttribute("class", "label-text");
    text.setAttribute("text-anchor", labelOffset.dx >= 0 ? "start" : "end");
    text.textContent = t.name;
    text.style.opacity = "0";
    g.appendChild(text);

    overlay.appendChild(g);

    return { ...t, color, dotEl: dot, ringEl: ring, lineEl: line, textEl: text };
  });
}

// Push label outward from the root so it doesn't overlap the tree.
function pickLabelOffset(x, y) {
  const dx = x - ROOT.x;
  const dy = y - ROOT.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const PUSH = 32;
  return { dx: ux * PUSH, dy: uy * PUSH };
}

function clearHighlightOverlay() {
  const o = document.getElementById("highlight-overlay");
  if (o) o.remove();
  state.tips = [];
}

// ----------------------------------------------------- labeler -----------

function buildLabelerOverlay(svg) {
  const overlay = document.createElementNS("http://www.w3.org/2000/svg", "g");
  overlay.setAttribute("id", "labeler-overlay");
  svg.appendChild(overlay);

  const stored = loadStoredTips() || [];
  // Build a quick lookup of named tips by rounded coordinates so we can show
  // existing tips with a different color and route clicks to the edit flow.
  const tipIndexByKey = new Map();
  stored.forEach((t, i) => {
    const key = `${Math.round(t.x)}_${Math.round(t.y)}`;
    tipIndexByKey.set(key, i);
  });

  for (const pt of state.candidatePoints) {
    const key = `${Math.round(pt.x)}_${Math.round(pt.y)}`;
    const editIdx = tipIndexByKey.get(key);
    const isExisting = editIdx !== undefined;

    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", pt.x);
    c.setAttribute("cy", pt.y);
    c.setAttribute("r", isExisting ? "6" : "5");
    c.setAttribute("class", "tip-marker");
    c.setAttribute(
      "fill",
      isExisting
        ? (stored[editIdx].color || state.colors.tip)
        : "rgba(108, 207, 255, 0.7)"
    );
    c.setAttribute("stroke", "#0b0d12");
    c.setAttribute("stroke-width", "1");
    c.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isExisting) {
        openLabelerDialog(pt.x, pt.y, editIdx);
      } else {
        openLabelerDialog(pt.x, pt.y);
      }
    });
    overlay.appendChild(c);
  }
}

function clearLabelerOverlay() {
  const o = document.getElementById("labeler-overlay");
  if (o) o.remove();
}

function openLabelerDialog(x, y, editIndex) {
  state.pendingTip = { x, y, editIndex };
  const dlg = document.querySelector(".labeler-dialog");
  const nameInput = dlg.querySelector('input[type="text"]');
  const colorInput = dlg.querySelector(".tip-color");
  const deleteBtn = dlg.querySelector(".delete");
  const label = dlg.querySelector("label");

  if (editIndex !== undefined) {
    const stored = loadStoredTips() || [];
    const tip = stored[editIndex];
    nameInput.value = tip ? tip.name : "";
    colorInput.value = (tip && tip.color) || state.colors.tip;
    deleteBtn.style.display = "inline-block";
    label.textContent = "Edit GPCR tip";
  } else {
    nameInput.value = "";
    colorInput.value = state.colors.tip;
    deleteBtn.style.display = "none";
    label.textContent = "GPCR name";
  }

  dlg.classList.add("open");
  setTimeout(() => nameInput.focus(), 30);
}

function closeLabelerDialog() {
  document.querySelector(".labeler-dialog").classList.remove("open");
  state.pendingTip = null;
}

function saveStoredTips(tips) {
  localStorage.setItem("gpcr-tips", JSON.stringify(tips));
}

function loadStoredTips() {
  try {
    const raw = localStorage.getItem("gpcr-tips");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function commitPendingTip(name, color) {
  if (!state.pendingTip || !name) return;
  const stored = loadStoredTips() || [];
  const { x, y, editIndex } = state.pendingTip;
  const entry = { name, x, y, color: color || state.colors.tip };
  if (editIndex !== undefined && stored[editIndex]) {
    stored[editIndex] = entry;
  } else {
    stored.push(entry);
  }
  saveStoredTips(stored);
  rebuildHighlights();
  // Refresh labeler overlay so the edited tip picks up the new color/state.
  if (state.labelMode) {
    clearLabelerOverlay();
    buildLabelerOverlay(document.querySelector(".stage svg"));
  }
  closeLabelerDialog();
}

function deletePendingTip() {
  if (!state.pendingTip || state.pendingTip.editIndex === undefined) return;
  const stored = loadStoredTips() || [];
  stored.splice(state.pendingTip.editIndex, 1);
  saveStoredTips(stored);
  rebuildHighlights();
  if (state.labelMode) {
    clearLabelerOverlay();
    buildLabelerOverlay(document.querySelector(".stage svg"));
  }
  closeLabelerDialog();
}

function rebuildHighlights() {
  const svg = document.querySelector(".stage svg");
  clearHighlightOverlay();
  const stored = loadStoredTips() || DEFAULT_TIPS;
  buildHighlightOverlay(svg, stored);
  applyProgress(getScrollProgress());
}

function exportTips() {
  const stored = loadStoredTips() || [];
  const blob = new Blob([JSON.stringify(stored, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "tips.json";
  a.click();
  URL.revokeObjectURL(url);
}

function clearTips() {
  if (!confirm("Clear all saved tips?")) return;
  localStorage.removeItem("gpcr-tips");
  rebuildHighlights();
}

// ----------------------------------------------------- color management --

function loadStoredColors() {
  try {
    const raw = localStorage.getItem("gpcr-colors");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function saveStoredColors(colors) {
  localStorage.setItem("gpcr-colors", JSON.stringify(colors));
}

function applyColors() {
  const root = document.documentElement;
  root.style.setProperty("--tree", state.colors.tree);
  root.style.setProperty("--tip-color", state.colors.tip);
  root.style.setProperty("--label-text", state.colors.label);
  root.style.setProperty("--bg", state.colors.bg);
  // Also recolor any existing highlight tips that didn't have an explicit
  // per-tip override (their stored color matches the previous global tip).
  rebuildHighlights();
}

function initColors() {
  const stored = loadStoredColors();
  if (stored) Object.assign(state.colors, stored);
  // Sync color picker UI with the loaded values.
  const map = {
    "color-tree": "tree",
    "color-tip": "tip",
    "color-label": "label",
    "color-bg": "bg",
  };
  for (const [id, key] of Object.entries(map)) {
    const input = document.getElementById(id);
    if (input) input.value = state.colors[key];
  }
  applyColors();
}

function resetColors() {
  state.colors = { ...DEFAULT_COLORS };
  saveStoredColors(state.colors);
  initColors();
}

function toggleSettings() {
  const panel = document.querySelector(".settings-panel");
  const btn = document.getElementById("toggle-settings");
  panel.classList.toggle("open");
  btn.classList.toggle("active", panel.classList.contains("open"));
}

// ----------------------------------------------------- embed export -----

// Build a self-contained HTML snippet that can be pasted into a Webflow
// Embed element. Includes scoped CSS, the SVG markup, the current color
// state, and an IIFE that runs the same scroll-driven animation against
// the embed's own bounding rect (so it doesn't fight Webflow's layout).
function generateEmbedCode() {
  const sourceSvg = document.querySelector(".stage svg");
  if (!sourceSvg) return "";

  // Clone the SVG and strip any overlays we've added at runtime.
  const svgClone = sourceSvg.cloneNode(true);
  const overlays = svgClone.querySelectorAll("#highlight-overlay, #labeler-overlay");
  overlays.forEach((o) => o.remove());
  // Reset any inline animation state on paths so the embed renders fresh.
  svgClone.querySelectorAll("path").forEach((p) => {
    p.style.strokeDasharray = "";
    p.style.strokeDashoffset = "";
    p.style.opacity = "";
  });
  const svgMarkup = svgClone.outerHTML;

  const tips = loadStoredTips() || [];
  const colors = state.colors;

  return `<!-- GPCR Tree scroll animation — paste into a Webflow Embed -->
<div class="gpcr-tree-embed" data-gpcr-tree>
  <div class="gpcr-sticky">
    <div class="gpcr-stage">
      ${svgMarkup}
    </div>
  </div>
</div>

<style>
  .gpcr-tree-embed {
    --gpcr-bg: ${colors.bg};
    --gpcr-tree: ${colors.tree};
    --gpcr-tip: ${colors.tip};
    --gpcr-label: ${colors.label};
    position: relative;
    width: 100%;
    height: 500vh;
    background: var(--gpcr-bg);
  }
  .gpcr-tree-embed .gpcr-sticky {
    position: sticky;
    top: 0;
    height: 100vh;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .gpcr-tree-embed .gpcr-stage {
    position: relative;
    width: min(92vmin, 1100px);
    aspect-ratio: 814 / 766;
  }
  .gpcr-tree-embed .gpcr-stage svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  .gpcr-tree-embed svg path[stroke] { stroke: var(--gpcr-tree); }
  .gpcr-tree-embed svg path[fill="black"] { fill: var(--gpcr-tree); }
  .gpcr-tree-embed .gpcr-label-text {
    font-family: "SF Mono", "Menlo", monospace;
    font-size: 14px;
    font-weight: 600;
    fill: var(--gpcr-label);
    paint-order: stroke;
    stroke: var(--gpcr-bg);
    stroke-width: 4;
    stroke-linejoin: round;
  }
  .gpcr-tree-embed .gpcr-label-line {
    stroke-width: 1;
    stroke-dasharray: 2 3;
    opacity: 0.6;
  }
</style>

<script>
(function () {
  var ROOT = { x: ${ROOT.x}, y: ${ROOT.y} };
  var GROW_RANGE = [0.0, 0.78];
  var HIGHLIGHT_RANGE = [0.78, 1.0];
  var BRANCH_DURATION = 0.18;
  var TIPS = ${JSON.stringify(tips)};
  var DEFAULT_TIP_COLOR = ${JSON.stringify(colors.tip)};

  // Find the most recently inserted embed container that hasn't been wired
  // up yet, so multiple embeds on the same page each grab their own DOM.
  var roots = document.querySelectorAll('.gpcr-tree-embed[data-gpcr-tree]');
  var root = roots[roots.length - 1];
  if (!root) return;
  root.removeAttribute('data-gpcr-tree');
  var svg = root.querySelector('svg');
  if (!svg) return;

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function smoothstep(a, b, x) {
    var t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

  // ---- minimal path normalizer (mirrors the dev tool) ----
  function parsePathCommands(d) {
    var out = [], re = /([MLHVCZ])([^MLHVCZ]*)/gi, m;
    while ((m = re.exec(d)) !== null) {
      var args = m[2].trim().split(/[\\s,]+/).filter(function (s) { return s.length > 0; }).map(Number);
      out.push({ cmd: m[1].toUpperCase(), args: args });
    }
    return out;
  }
  function commandsToVertices(cmds) {
    var verts = [], cx = 0, cy = 0, sx = 0, sy = 0;
    cmds.forEach(function (c) {
      var a = c.args;
      if (c.cmd === 'M') {
        for (var i = 0; i < a.length; i += 2) {
          cx = a[i]; cy = a[i + 1];
          if (i === 0) { verts.push({ x: cx, y: cy, seg: 'M' }); sx = cx; sy = cy; }
          else verts.push({ x: cx, y: cy, seg: 'L' });
        }
      } else if (c.cmd === 'L') {
        for (var i = 0; i < a.length; i += 2) { cx = a[i]; cy = a[i + 1]; verts.push({ x: cx, y: cy, seg: 'L' }); }
      } else if (c.cmd === 'H') {
        for (var i = 0; i < a.length; i++) { cx = a[i]; verts.push({ x: cx, y: cy, seg: 'L' }); }
      } else if (c.cmd === 'V') {
        for (var i = 0; i < a.length; i++) { cy = a[i]; verts.push({ x: cx, y: cy, seg: 'L' }); }
      } else if (c.cmd === 'C') {
        for (var i = 0; i < a.length; i += 6) {
          verts.push({ x: a[i+4], y: a[i+5], seg: 'C', cp1x: a[i], cp1y: a[i+1], cp2x: a[i+2], cp2y: a[i+3] });
          cx = a[i+4]; cy = a[i+5];
        }
      } else if (c.cmd === 'Z') {
        if (verts.length > 0 && (cx !== sx || cy !== sy)) verts.push({ x: sx, y: sy, seg: 'L' });
        cx = sx; cy = sy;
      }
    });
    return verts;
  }
  function vertsToD(v) {
    if (!v.length) return '';
    var out = ['M' + v[0].x + ' ' + v[0].y];
    for (var i = 1; i < v.length; i++) {
      var s = v[i];
      if (s.seg === 'C') out.push('C' + s.cp1x + ' ' + s.cp1y + ' ' + s.cp2x + ' ' + s.cp2y + ' ' + s.x + ' ' + s.y);
      else out.push('L' + s.x + ' ' + s.y);
    }
    return out.join('');
  }
  function reverseVerts(v) {
    if (v.length < 2) return v.slice();
    var last = v[v.length - 1];
    var out = [{ x: last.x, y: last.y, seg: 'M' }];
    for (var i = v.length - 1; i > 0; i--) {
      var cur = v[i], prev = v[i - 1];
      if (cur.seg === 'C') out.push({ x: prev.x, y: prev.y, seg: 'C', cp1x: cur.cp2x, cp1y: cur.cp2y, cp2x: cur.cp1x, cp2y: cur.cp1y });
      else out.push({ x: prev.x, y: prev.y, seg: 'L' });
    }
    return out;
  }
  function closestIdx(v, rx, ry) {
    var min = Infinity, mi = 0;
    for (var i = 0; i < v.length; i++) {
      var d = Math.hypot(v[i].x - rx, v[i].y - ry);
      if (d < min) { min = d; mi = i; }
    }
    return mi;
  }
  function normalizeAndSplit(el) {
    var d = el.getAttribute('d');
    if (!d) return [el];
    var v = commandsToVertices(parsePathCommands(d));
    if (v.length < 2) return [el];
    var idx = closestIdx(v, ROOT.x, ROOT.y);
    if (idx === 0) return [el];
    if (idx === v.length - 1) {
      el.setAttribute('d', vertsToD(reverseVerts(v)));
      return [el];
    }
    var first = v.slice(0, idx + 1);
    var second = v.slice(idx);
    el.setAttribute('d', vertsToD(reverseVerts(first)));
    var clone = el.cloneNode(false);
    clone.setAttribute('d', vertsToD(second));
    el.parentNode.insertBefore(clone, el.nextSibling);
    return [el, clone];
  }

  var paths = [];
  var allPaths = Array.from(svg.querySelectorAll('path'));
  allPaths.forEach(function (el) {
    var isFill = el.getAttribute('fill') === 'black' && !el.getAttribute('stroke');
    normalizeAndSplit(el).forEach(function (e) {
      paths.push({ el: e, isFill: isFill });
    });
  });

  paths.forEach(function (p) {
    p.len = Math.max(p.el.getTotalLength(), 0.0001);
    var s = p.el.getPointAtLength(0);
    p.distFromRoot = dist(s.x, s.y, ROOT.x, ROOT.y);
    if (!p.isFill) {
      p.el.style.strokeDasharray = p.len + ' ' + p.len;
      p.el.style.strokeDashoffset = p.len;
    } else {
      p.el.style.opacity = '0';
    }
  });
  var maxReach = 1;
  paths.forEach(function (p) { if (p.distFromRoot + p.len > maxReach) maxReach = p.distFromRoot + p.len; });
  paths.forEach(function (p) {
    var norm = p.distFromRoot / maxReach;
    var lenW = Math.min(1, (p.len / maxReach) * 1.4);
    p.t0 = norm * (1 - BRANCH_DURATION);
    p.t1 = p.t0 + BRANCH_DURATION + lenW * 0.05;
    if (p.t1 > 1) p.t1 = 1;
  });

  // ---- highlight overlay ----
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var overlay = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(overlay);
  var tipEls = TIPS.map(function (t) {
    var color = t.color || DEFAULT_TIP_COLOR;
    var dx = t.x - ROOT.x, dy = t.y - ROOT.y;
    var len = Math.hypot(dx, dy) || 1;
    var lx = t.x + (dx / len) * 32;
    var ly = t.y + (dy / len) * 32;

    var line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', t.x); line.setAttribute('y1', t.y);
    line.setAttribute('x2', lx);  line.setAttribute('y2', ly);
    line.setAttribute('class', 'gpcr-label-line');
    line.style.stroke = color;
    line.style.opacity = '0';
    overlay.appendChild(line);

    var ring = document.createElementNS(SVG_NS, 'circle');
    ring.setAttribute('cx', t.x); ring.setAttribute('cy', t.y);
    ring.setAttribute('r', '0');
    ring.style.fill = 'none';
    ring.style.stroke = color;
    ring.style.strokeWidth = '1.5';
    overlay.appendChild(ring);

    var dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', t.x); dot.setAttribute('cy', t.y);
    dot.setAttribute('r', '0');
    dot.style.fill = color;
    dot.style.filter = 'drop-shadow(0 0 6px ' + color + ')';
    overlay.appendChild(dot);

    var text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', lx + (dx >= 0 ? 6 : -6));
    text.setAttribute('y', ly + 4);
    text.setAttribute('class', 'gpcr-label-text');
    text.setAttribute('text-anchor', dx >= 0 ? 'start' : 'end');
    text.textContent = t.name;
    text.style.opacity = '0';
    overlay.appendChild(text);

    return { dot: dot, ring: ring, line: line, text: text };
  });

  // ---- scroll-driven progress ----
  function progress() {
    var rect = root.getBoundingClientRect();
    var total = root.offsetHeight - window.innerHeight;
    if (total <= 0) return 0;
    return clamp01(-rect.top / total);
  }

  function apply(p) {
    var growT = smoothstep(GROW_RANGE[0], GROW_RANGE[1], p);
    paths.forEach(function (path) {
      var local = clamp01((growT - path.t0) / (path.t1 - path.t0));
      if (path.isFill) {
        path.el.style.opacity = local > 0.85 ? '1' : '0';
      } else {
        path.el.style.strokeDashoffset = path.len * (1 - local);
      }
    });
    var hiT = smoothstep(HIGHLIGHT_RANGE[0], HIGHLIGHT_RANGE[1], p);
    tipEls.forEach(function (t, i) {
      var stagger = tipEls.length > 1 ? i / tipEls.length : 0;
      var appear = clamp01((hiT - stagger * 0.6) / 0.4);
      t.dot.setAttribute('r', lerp(0, 7, appear));
      t.ring.setAttribute('r', lerp(0, 14, appear));
      t.ring.style.opacity = appear * 0.8;
      t.line.style.opacity = appear * 0.6;
      t.text.style.opacity = appear;
    });
  }

  var pending = false;
  function onScroll() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () { pending = false; apply(progress()); });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  apply(progress());
})();
</script>
`;
}

function openEmbedModal() {
  const modal = document.querySelector(".export-modal");
  const backdrop = document.querySelector(".modal-backdrop");
  const textarea = modal.querySelector("textarea");
  textarea.value = generateEmbedCode();
  modal.classList.add("open");
  backdrop.classList.add("open");
  setTimeout(() => textarea.select(), 30);
}

function closeEmbedModal() {
  document.querySelector(".export-modal").classList.remove("open");
  document.querySelector(".modal-backdrop").classList.remove("open");
}

function copyEmbedCode() {
  const textarea = document.querySelector(".export-modal textarea");
  textarea.select();
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(textarea.value);
    } else {
      document.execCommand("copy");
    }
    const btn = document.querySelector(".export-modal .copy");
    const original = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = original; }, 1500);
  } catch (e) {
    console.error("Copy failed", e);
  }
}

// ----------------------------------------------------- guide modal ------

function openGuide() {
  document.querySelector(".guide-modal").classList.add("open");
  document.querySelector(".modal-backdrop").classList.add("open");
  localStorage.setItem("gpcr-guide-seen", "1");
}

function closeGuide() {
  document.querySelector(".guide-modal").classList.remove("open");
  document.querySelector(".modal-backdrop").classList.remove("open");
}

function maybeShowGuideOnFirstVisit() {
  if (!localStorage.getItem("gpcr-guide-seen")) {
    openGuide();
  }
}

function toggleLabelMode() {
  state.labelMode = !state.labelMode;
  const btn = document.getElementById("toggle-label");
  const svg = document.querySelector(".stage svg");
  btn.classList.toggle("active", state.labelMode);
  if (state.labelMode) {
    // Force the tree fully drawn so users can see all tips.
    window.scrollTo(0, document.documentElement.scrollHeight);
    buildLabelerOverlay(svg);
  } else {
    clearLabelerOverlay();
  }
}

// ----------------------------------------------------- bootstrap ---------

function init() {
  const svg = document.querySelector(".stage svg");
  if (!svg) {
    console.error("No SVG found in .stage");
    return;
  }

  preparePaths(svg);
  initColors();
  rebuildHighlights();
  applyProgress(getScrollProgress());

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);

  document.getElementById("toggle-label").addEventListener("click", toggleLabelMode);
  document.getElementById("toggle-settings").addEventListener("click", toggleSettings);
  document.getElementById("open-embed").addEventListener("click", openEmbedModal);
  document.getElementById("export-tips").addEventListener("click", exportTips);
  document.getElementById("clear-tips").addEventListener("click", clearTips);
  document.getElementById("reset-colors").addEventListener("click", resetColors);

  // Color picker handlers — write through to state, persist, and apply.
  const colorMap = {
    "color-tree": "tree",
    "color-tip": "tip",
    "color-label": "label",
    "color-bg": "bg",
  };
  Object.entries(colorMap).forEach(([id, key]) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener("input", (e) => {
      state.colors[key] = e.target.value;
      saveStoredColors(state.colors);
      applyColors();
    });
  });

  // Labeler dialog wiring (name + per-tip color + delete + save).
  const dlg = document.querySelector(".labeler-dialog");
  const nameInput = dlg.querySelector('input[type="text"]');
  const colorInput = dlg.querySelector(".tip-color");
  dlg.querySelector(".save").addEventListener("click", () => {
    commitPendingTip(nameInput.value.trim(), colorInput.value);
  });
  dlg.querySelector(".cancel").addEventListener("click", closeLabelerDialog);
  dlg.querySelector(".delete").addEventListener("click", deletePendingTip);
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commitPendingTip(nameInput.value.trim(), colorInput.value);
    if (e.key === "Escape") closeLabelerDialog();
  });

  // Embed export modal wiring.
  const modal = document.querySelector(".export-modal");
  modal.querySelector(".close").addEventListener("click", closeEmbedModal);
  modal.querySelector(".copy").addEventListener("click", copyEmbedCode);

  // Guide modal wiring.
  document.getElementById("open-guide").addEventListener("click", openGuide);
  document.querySelector(".guide-modal .close").addEventListener("click", closeGuide);

  // Shared backdrop closes whichever modal is open.
  document.querySelector(".modal-backdrop").addEventListener("click", () => {
    closeEmbedModal();
    closeGuide();
  });

  // Auto-open the guide the first time the page loads.
  maybeShowGuideOnFirstVisit();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
