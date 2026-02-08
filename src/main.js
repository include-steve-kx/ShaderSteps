// ============================================================
// main.js — Wires ShaderEngine + ShaderEditor + UI together
// ============================================================

import { ShaderEngine } from './engine/shader-engine.js';
import { ShaderEditor } from './editor/shader-editor.js';

// Friendly labels for passes
const PASS_LABELS = {
  Common: 'Common',
  A: 'Buffer A',
  B: 'Buffer B',
  C: 'Buffer C',
  D: 'Buffer D',
  Image: 'Image',
};

// All possible buffer keys that can be channel sources
const BUFFER_KEYS = ['A', 'B', 'C', 'D'];

// Default tabs (always present)
const DEFAULT_TABS = ['Common', 'A', 'B', 'C', 'D', 'Image'];

// Which passes produce visual output (get canvases)
const VISUAL_PASSES = ['A', 'B', 'C', 'D', 'Image'];

// ============================================================
// Boot
// ============================================================

const glCanvas = document.getElementById('gl-canvas');
const engine = new ShaderEngine(glCanvas);
const editor = new ShaderEditor(document.getElementById('editor-container'));

// State
let activeTab = 'Image';
let canvasCards = new Map();  // passKey -> { card, canvas, btnVis, btnMax, visible }
let maximizedPass = null;

// ============================================================
// Initialize editor tabs
// ============================================================

editor.setTabs(DEFAULT_TABS);

// Set default shader code for Image so something shows up immediately
editor.setSource('Image',
`void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    fragColor = vec4(uv, 0.5 + 0.5 * sin(iTime), 1.0);
}
`);

editor.setActiveTab('Image');

// ============================================================
// Build tab bar UI
// ============================================================

const tabBarEl = document.getElementById('tab-bar');

function buildTabBar() {
  tabBarEl.innerHTML = '';
  for (const key of DEFAULT_TABS) {
    const btn = document.createElement('button');
    btn.className = 'tab' + (key === activeTab ? ' active' : '');
    btn.textContent = PASS_LABELS[key] || key;
    btn.dataset.pass = key;
    btn.addEventListener('click', () => {
      activeTab = key;
      editor.setActiveTab(key);
      refreshTabHighlights();
      refreshCanvasHighlights();
      refreshChannelDropdowns();
    });
    tabBarEl.appendChild(btn);
  }
}

function refreshTabHighlights() {
  const tabs = tabBarEl.querySelectorAll('.tab');
  tabs.forEach(t => {
    t.classList.toggle('active', t.dataset.pass === activeTab);
  });
}

// ============================================================
// Build canvas row
// ============================================================

const canvasRowEl = document.getElementById('canvas-row');

function buildCanvasRow() {
  // Unregister previous display canvases
  for (const key of canvasCards.keys()) {
    engine.unregisterDisplayCanvas(key);
  }
  canvasRowEl.innerHTML = '';
  canvasCards.clear();

  // Determine which passes have source code
  const sources = editor.getAllSources();
  const activePasses = VISUAL_PASSES.filter(k => sources[k] && sources[k].trim() !== '');

  for (const key of activePasses) {
    const card = document.createElement('div');
    card.className = 'canvas-card';
    card.dataset.pass = key;

    // Label
    const label = document.createElement('div');
    label.className = 'canvas-card-label';
    label.textContent = PASS_LABELS[key] || key;
    card.appendChild(label);

    // 2D display canvas (buffer size matches hidden GL canvas)
    const cvs = document.createElement('canvas');
    cvs.width = 640;
    cvs.height = 360;
    card.appendChild(cvs);

    // Controls row
    const controls = document.createElement('div');
    controls.className = 'canvas-card-controls';

    const btnVis = document.createElement('button');
    btnVis.className = 'btn';
    btnVis.textContent = '[ eye ]';
    btnVis.title = 'Toggle visibility';

    const btnMax = document.createElement('button');
    btnMax.className = 'btn';
    btnMax.textContent = '[ ^ ]';
    btnMax.title = 'Maximize';

    controls.appendChild(btnVis);
    controls.appendChild(btnMax);
    card.appendChild(controls);
    canvasRowEl.appendChild(card);

    const state = { card, canvas: cvs, btnVis, btnMax, visible: true };
    canvasCards.set(key, state);

    // Register with engine
    engine.registerDisplayCanvas(key, cvs);

    // -- Mouse events (scale CSS coords → buffer coords) --
    function scaleMouse(e) {
      const scaleX = cvs.width / cvs.clientWidth;
      const scaleY = cvs.height / cvs.clientHeight;
      return {
        x: e.offsetX * scaleX,
        y: cvs.height - e.offsetY * scaleY,
      };
    }

    cvs.addEventListener('mousemove', (e) => {
      const m = scaleMouse(e);
      engine.updateMouse(m.x, m.y, engine._mouse.clickX, engine._mouse.clickY);
    });
    cvs.addEventListener('mousedown', (e) => {
      const m = scaleMouse(e);
      engine.updateMouse(m.x, m.y, m.x, m.y);
    });
    cvs.addEventListener('mouseup', () => {
      engine.updateMouse(engine._mouse.x, engine._mouse.y, 0, 0);
    });

    // -- Visibility toggle --
    btnVis.addEventListener('click', () => {
      state.visible = !state.visible;
      card.classList.toggle('hidden-pass', !state.visible);
      btnVis.textContent = state.visible ? '[ eye ]' : '[ --- ]';
      engine.setDisplayVisible(key, state.visible);
    });

    // -- Maximize --
    btnMax.addEventListener('click', () => {
      openMaximize(key);
    });
  }

  refreshCanvasHighlights();
}

function refreshCanvasHighlights() {
  for (const [key, state] of canvasCards) {
    state.card.classList.toggle('highlighted', key === activeTab);
  }
}

// ============================================================
// Maximize overlay
// ============================================================

const maximizeOverlay = document.getElementById('maximize-overlay');
const maximizeCanvas = document.getElementById('maximize-canvas');
const maximizeClose = document.getElementById('maximize-close');

function openMaximize(passKey) {
  maximizedPass = passKey;
  maximizeCanvas.width = 640;
  maximizeCanvas.height = 360;
  maximizeOverlay.classList.remove('hidden');
  // Immediately blit current frame
  engine.blitToCanvas(passKey, maximizeCanvas);
}

function closeMaximize() {
  maximizedPass = null;
  maximizeOverlay.classList.add('hidden');
}

maximizeClose.addEventListener('click', closeMaximize);
maximizeOverlay.addEventListener('click', (e) => {
  if (e.target === maximizeOverlay) closeMaximize();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && maximizedPass != null) closeMaximize();
});

// Update maximized canvas each frame
function updateMaximize() {
  if (maximizedPass != null) {
    engine.blitToCanvas(maximizedPass, maximizeCanvas);
  }
}

// ============================================================
// Channel config dropdowns
// ============================================================

const channelSelects = document.querySelectorAll('.ch-select');

function refreshChannelDropdowns() {
  // Populate dropdown options
  channelSelects.forEach(sel => {
    const chIdx = parseInt(sel.dataset.ch);
    sel.innerHTML = '<option value="">None</option>';
    for (const bk of BUFFER_KEYS) {
      const opt = document.createElement('option');
      opt.value = bk;
      opt.textContent = PASS_LABELS[bk];
      sel.appendChild(opt);
    }

    // Set current value if the active tab has this channel configured
    if (activeTab && activeTab !== 'Common') {
      const current = engine.getChannel(activeTab, chIdx);
      sel.value = current || '';
    } else {
      sel.value = '';
    }
  });
}

channelSelects.forEach(sel => {
  sel.addEventListener('change', () => {
    const chIdx = parseInt(sel.dataset.ch);
    if (activeTab && activeTab !== 'Common') {
      engine.setChannel(activeTab, chIdx, sel.value || null);
    }
  });
});

// ============================================================
// Compile button
// ============================================================

const btnCompile = document.getElementById('btn-compile');
const errorOutput = document.getElementById('error-output');

function doCompile() {
  // Sync all sources from editor to engine
  const sources = editor.getAllSources();
  engine.setCommon(sources['Common'] || '');
  for (const key of VISUAL_PASSES) {
    if (sources[key] && sources[key].trim() !== '') {
      engine.setPass(key, sources[key]);
    } else {
      engine.removePass(key);
    }
  }

  const result = engine.compile();

  // Update error display
  if (result.success) {
    errorOutput.textContent = '> errors: none';
    errorOutput.classList.remove('has-errors');
  } else {
    const lines = result.errors.map(e => `[${PASS_LABELS[e.pass] || e.pass}] ${e.message}`);
    errorOutput.textContent = '> errors:\n' + lines.join('\n');
    errorOutput.classList.add('has-errors');
  }

  // Rebuild canvas row (passes may have changed)
  buildCanvasRow();

  // If not playing, render one frame to see the result
  if (!engine.isPlaying) {
    engine.resetTime();
  }
}

btnCompile.addEventListener('click', doCompile);

// Also allow Ctrl/Cmd+Enter to compile
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    doCompile();
  }
});

// ============================================================
// Playback controls
// ============================================================

const btnReset = document.getElementById('btn-reset');
const btnPlayPause = document.getElementById('btn-playpause');
const timeDisplay = document.getElementById('time-display');

btnReset.addEventListener('click', () => {
  engine.resetTime();
});

btnPlayPause.addEventListener('click', () => {
  if (engine.isPlaying) {
    engine.pause();
    btnPlayPause.textContent = '[ ▶ PLAY ]';
  } else {
    engine.play();
    btnPlayPause.textContent = '[ ⏸ PAUSE ]';
  }
});

// Time display update loop
function updateTimeDisplay() {
  timeDisplay.textContent = engine.time.toFixed(2) + 's';
  updateMaximize();
  requestAnimationFrame(updateTimeDisplay);
}

// ============================================================
// Editor tab change → highlight canvas
// ============================================================

editor.onTabChange((key) => {
  refreshChannelDropdowns();
});

// ============================================================
// Initial compile & start
// ============================================================

buildTabBar();
doCompile();
refreshChannelDropdowns();
updateTimeDisplay();

// Auto-play
engine.play();
btnPlayPause.textContent = '[ ⏸ PAUSE ]';
