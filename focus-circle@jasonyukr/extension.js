// Focus Circle Highlight GNOME Shell Extension
// GNOME 40-compatible implementation (legacy init/enable/disable style)
 // Draws a faint 30% opacity circle at the top-left of the focused window for 10 seconds.
// Hides immediately when focus is lost or the extension is disabled.

const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Meta = imports.gi.Meta;
const Main = imports.ui.main;
const Cairo = imports.cairo;

class FocusCircleImpl {
  constructor() {
    const themeContext = St.ThemeContext.get_for_stage(global.stage);
    this._scale = (themeContext && themeContext.scale_factor) ? themeContext.scale_factor : 1;
    const titlePx = 32 * this._scale; // generic GNOME titlebar height baseline
    this._size = Math.round(titlePx * 0.504)  // reduced to 72% of previous (0.7 * 0.72 = 0.504)
    this._inset = Math.round(titlePx * 0.15); // margin from top-left
    this._hideTimeoutId = 0;
    this._focusChangedId = 0;
    this._scaleChangedId = 0;
    this._monitorsChangedId = 0;
    this._monitorManager = null;
    // Track geometry change handling to suppress rendering while window is moving/resizing
    this._geometryChangeIds = [];
    this._currentWindow = null;
    this._suppressForWindow = null;

    // Create overlay widget with a Canvas content that draws a circle
    this._overlay = new St.Widget({
      reactive: false,
      width: this._size,
      height: this._size,
      x: 0,
      y: 0,
      visible: false,
      style: 'background-color: transparent;',
    });

    this._canvas = new Clutter.Canvas();
    this._canvas.set_size(this._size, this._size);
    this._canvas.connect('draw', (c, cr, w, h) => {
      // Clear background for transparency, then draw the circle at 30% opacity
      cr.setOperator(Cairo.Operator.CLEAR);
      cr.paint();
      cr.setOperator(Cairo.Operator.OVER);

      // Filled circle at 30% opacity with a subtle border
      const radius = Math.min(w, h) / 2 - 1;
      cr.setSourceRGBA(1, 1, 0, 0.3); // 30% opacity yellow fill
      cr.arc(w / 2, h / 2, radius, 0, 2 * Math.PI);
      cr.fillPreserve();

      cr.setSourceRGBA(1, 1, 0, 0.2); // faint yellow border to increase visibility
      cr.setLineWidth(2.0);
      cr.stroke();

      return true;
    });
    this._overlay.set_content(this._canvas);
    Main.uiGroup.add_child(this._overlay);

    // React to scale/monitor changes to keep size consistent with title area
    const themeContext2 = St.ThemeContext.get_for_stage(global.stage);
    this._scaleChangedId = themeContext2.connect('notify::scale-factor', () => this._recomputeSize());
    // Monitor changes: use Meta.MonitorManager when available (newer GNOME), fall back to MetaDisplay (older)
    this._monitorManager =
      (global.display && global.display.get_monitor_manager) ? global.display.get_monitor_manager()
      : (global.backend && global.backend.get_monitor_manager) ? global.backend.get_monitor_manager()
      : null;

    if (this._monitorManager && this._monitorManager.connect) {
      this._monitorsChangedId = this._monitorManager.connect('monitors-changed', () => this._recomputeSize());
    } else if (Main.layoutManager && Main.layoutManager.connect) {
      // Fallback: listen on LayoutManager which proxies monitor topology changes
      this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this._recomputeSize());
    }

    // Listen to focus changes
    this._focusChangedId = global.display.connect(
      'notify::focus-window',
      this._onFocusChanged.bind(this),
    );

    // Initial state
    this._onFocusChanged();
  }

  destroy() {
    if (this._focusChangedId) {
      global.display.disconnect(this._focusChangedId);
      this._focusChangedId = 0;
    }
    const themeContext = St.ThemeContext.get_for_stage(global.stage);
    if (this._scaleChangedId) {
      themeContext.disconnect(this._scaleChangedId);
      this._scaleChangedId = 0;
    }
    if (this._monitorsChangedId) {
      if (this._monitorManager && this._monitorManager.disconnect) {
        this._monitorManager.disconnect(this._monitorsChangedId);
      } else if (Main.layoutManager && Main.layoutManager.disconnect) {
        Main.layoutManager.disconnect(this._monitorsChangedId);
      }
      this._monitorsChangedId = 0;
    }
    this._disconnectGeometrySignals();
    this._currentWindow = null;
    this._suppressForWindow = null;
    this._monitorManager = null;
    this._cancelHideTimeout();

    if (this._overlay) {
      this._overlay.destroy();
      this._overlay = null;
    }
  }

  _cancelHideTimeout() {
    if (this._hideTimeoutId) {
      GLib.Source.remove(this._hideTimeoutId);
      this._hideTimeoutId = 0;
    }
  }

  _disconnectGeometrySignals() {
    if (this._geometryChangeIds && this._geometryChangeIds.length) {
      for (const [obj, id] of this._geometryChangeIds) {
        try {
          obj.disconnect(id);
        } catch (e) {
          // ignore disconnect errors
        }
      }
      this._geometryChangeIds = [];
    }
  }

  _connectGeometrySignals(win) {
    this._disconnectGeometrySignals();
    if (!win || !win.connect) return;

    this._geometryChangeIds = [];
    try {
      const idPos = win.connect('position-changed', this._onPositionChanged.bind(this));
      this._geometryChangeIds.push([win, idPos]);
    } catch (e) {
      // Some Mutter versions may not support all signals; ignore
    }
    try {
      const idSize = win.connect('size-changed', this._onSizeChanged.bind(this));
      this._geometryChangeIds.push([win, idSize]);
    } catch (e) {
      // Some Mutter versions may not support all signals; ignore
    }
  }

  _onPositionChanged() {
    // Dismiss when window location changes (move)
    this._suppressForWindow = this._currentWindow;
    if (this._overlay) this._overlay.hide();
    this._cancelHideTimeout();
  }

  _onSizeChanged() {
    // Keep the circle visible on resize; just reposition/redraw if needed
    if (!this._currentWindow || !this._overlay) return;
    const rect = this._currentWindow.get_frame_rect();
    const x = rect.x + this._inset;
    const y = rect.y + this._inset;
    this._overlay.set_position(x, y);
    const content = this._overlay.get_content && this._overlay.get_content();
    if (content && content.invalidate) content.invalidate();
    // Do NOT cancel the hide timeout; dismissal should be by timeout or location change
  }

  _recomputeSize() {
    const themeContext = St.ThemeContext.get_for_stage(global.stage);
    this._scale = (themeContext && themeContext.scale_factor) ? themeContext.scale_factor : 1;
    const titlePx = 32 * this._scale;
    this._size = Math.round(titlePx * 0.42);
    this._inset = Math.round(titlePx * 0.15);

    if (this._overlay) {
      this._overlay.set_size(this._size, this._size);
    }
    if (this._canvas) {
      this._canvas.set_size(this._size, this._size);
      if (this._canvas.invalidate) this._canvas.invalidate();
    }

    this._onFocusChanged();
  }

  _onFocusChanged() {
    const win = global.display.get_focus_window
      ? global.display.get_focus_window()
      : global.display.focus_window;

    const prevWin = this._currentWindow;

    // Hide and disconnect if no focused window or unsuitable window types
    if (!win || win.minimized || win.window_type === Meta.WindowType.DESKTOP) {
      this._disconnectGeometrySignals();
      this._currentWindow = null;
      if (this._overlay) this._overlay.hide();
      this._cancelHideTimeout();
      return;
    }

    // If focus moved to a different window, clear suppression
    if (prevWin !== win) {
      this._suppressForWindow = null;
    }

    this._currentWindow = win;
    this._connectGeometrySignals(win);

    // If suppressed for this window due to geometry change, do not render
    if (this._suppressForWindow === win) {
      if (this._overlay) this._overlay.hide();
      this._cancelHideTimeout();
      return;
    }

    // Position the circle at the top-left corner inside the frame
    const rect = win.get_frame_rect();
    const x = rect.x + this._inset;
    const y = rect.y + this._inset;

    if (this._overlay) {
      this._overlay.set_position(x, y);
      this._overlay.show();

      // Ensure redraw (in case of scale/monitor changes)
      const content = this._overlay.get_content && this._overlay.get_content();
      if (content && content.invalidate) {
        content.invalidate();
      }
    }

    // Auto-hide after 10 seconds
    this._cancelHideTimeout();
    this._hideTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
      if (this._overlay) this._overlay.hide();
      this._hideTimeoutId = 0;
      return GLib.SOURCE_REMOVE;
    });
  }
}

let _focusCircle = null;

// Legacy GNOME Shell extension entry points for GNOME 40.x
function init() {}

function enable() {
  if (!_focusCircle)
    _focusCircle = new FocusCircleImpl();
}

function disable() {
  if (_focusCircle) {
    _focusCircle.destroy();
    _focusCircle = null;
  }
}
