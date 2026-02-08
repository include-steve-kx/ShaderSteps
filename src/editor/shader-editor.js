// ============================================================
// ShaderEditor — CodeMirror 6 wrapper with tabbed pass editing
// ============================================================
// Manages one CM instance. When tabs switch, the current source
// is saved to a Map and the new tab's source is loaded.
// ============================================================

import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { cpp } from '@codemirror/lang-cpp';
import { oneDark } from '@codemirror/theme-one-dark';

// Monospace theme overrides for the ASCII art look
const asciiTheme = EditorView.theme({
  '&': {
    fontSize: '13px',
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
  },
  '.cm-content': {
    caretColor: '#00ff88',
  },
  '.cm-cursor': {
    borderLeftColor: '#00ff88',
  },
  '&.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: '#264f3d',
  },
});


export class ShaderEditor {

  /**
   * @param {HTMLElement} containerElement — where the CM editor mounts
   */
  constructor(containerElement) {
    this._container = containerElement;

    // Source code storage per tab key: Map<string, string>
    this._sources = new Map();

    // Ordered list of tab keys
    this._tabKeys = [];

    // Currently active tab
    this._activeTab = null;

    // Tab-change callbacks
    this._onTabChangeCallbacks = [];

    // Create CodeMirror
    this._view = new EditorView({
      state: EditorState.create({
        doc: '// select a tab to begin editing\n',
        extensions: [
          basicSetup,
          cpp(),
          oneDark,
          asciiTheme,
          EditorView.lineWrapping,
        ],
      }),
      parent: containerElement,
    });
  }

  // ===========================================================
  // Tab management
  // ===========================================================

  /**
   * Set the available tabs and their order.
   * @param {string[]} passKeys — e.g. ['Common','A','D','Image']
   */
  setTabs(passKeys) {
    this._tabKeys = [...passKeys];
    // Initialize any missing source entries
    for (const key of passKeys) {
      if (!this._sources.has(key)) {
        this._sources.set(key, '');
      }
    }
  }

  getTabs() {
    return [...this._tabKeys];
  }

  getActiveTab() {
    return this._activeTab;
  }

  /**
   * Switch to a tab, saving current content first.
   */
  setActiveTab(key) {
    if (!this._tabKeys.includes(key)) return;

    // Save current editor content
    if (this._activeTab != null) {
      this._sources.set(this._activeTab, this._view.state.doc.toString());
    }

    this._activeTab = key;

    // Load new tab's content
    const src = this._sources.get(key) ?? '';
    this._view.dispatch({
      changes: {
        from: 0,
        to: this._view.state.doc.length,
        insert: src,
      },
    });

    // Notify listeners
    for (const cb of this._onTabChangeCallbacks) {
      cb(key);
    }
  }

  /**
   * Register a callback for tab changes.
   * @param {function(string):void} callback
   */
  onTabChange(callback) {
    this._onTabChangeCallbacks.push(callback);
  }

  // ===========================================================
  // Source access
  // ===========================================================

  /**
   * Get source code for a specific tab.
   * If the tab is currently active, reads from editor.
   */
  getSource(key) {
    if (key === this._activeTab) {
      return this._view.state.doc.toString();
    }
    return this._sources.get(key) ?? '';
  }

  /**
   * Set source code for a tab. If it's the active tab, updates the editor.
   */
  setSource(key, code) {
    this._sources.set(key, code);
    if (key === this._activeTab) {
      this._view.dispatch({
        changes: {
          from: 0,
          to: this._view.state.doc.length,
          insert: code,
        },
      });
    }
  }

  /**
   * Get all sources as an object { Common: "...", A: "...", ... }
   */
  getAllSources() {
    // Make sure the active tab is saved
    if (this._activeTab != null) {
      this._sources.set(this._activeTab, this._view.state.doc.toString());
    }
    const result = {};
    for (const [key, val] of this._sources) {
      result[key] = val;
    }
    return result;
  }
}
