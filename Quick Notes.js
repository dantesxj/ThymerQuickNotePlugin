// ==Plugin==
// name: Quick Note
// description: Create a timestamped note in any configured collection
// icon: ti-bolt
// ==/Plugin==



// @generated BEGIN thymer-ext-path-b (source: plugins/plugin-settings/ThymerExtPathBRuntime.js — edit that file, then npm run embed-path-b)
/**
 * ThymerExtPathB — shared path-B storage (Plugin Settings collection + localStorage mirror).
 * Edit this file in the repo, then run `npm run embed-path-b` to refresh embedded copies inside each Path B plugin.
 *
 * API: ThymerExtPathB.init({ plugin, pluginId, modeKey, mirrorKeys, label, data, ui })
 *      ThymerExtPathB.scheduleFlush(plugin, mirrorKeys)
 *      ThymerExtPathB.openStorageDialog(plugin, { pluginId, modeKey, mirrorKeys, label, data, ui })
 */
(function pathBRuntime(g) {
  if (g.ThymerExtPathB) return;

  const COL_NAME = 'Plugin Settings';
  const q = [];
  let busy = false;

  function drain() {
    if (busy || !q.length) return;
    busy = true;
    const job = q.shift();
    Promise.resolve(typeof job === 'function' ? job() : job)
      .catch((e) => console.error('[ThymerExtPathB]', e))
      .finally(() => {
        busy = false;
        if (q.length) setTimeout(drain, 450);
      });
  }

  function enqueue(job) {
    q.push(job);
    drain();
  }

  async function findColl(data) {
    try {
      const all = await data.getAllCollections();
      return all.find((c) => (c.getName?.() || '') === COL_NAME) || null;
    } catch (_) {
      return null;
    }
  }

  async function readDoc(data, pluginId) {
    const coll = await findColl(data);
    if (!coll) return null;
    let records;
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return null;
    }
    const r = records.find((x) => (x.text?.('plugin_id') || '').trim() === pluginId);
    if (!r) return null;
    let raw = '';
    try {
      raw = r.text?.('settings_json') || '';
    } catch (_) {}
    if (!raw || !String(raw).trim()) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  async function writeDoc(data, pluginId, doc) {
    const coll = await findColl(data);
    if (!coll) return;
    const json = JSON.stringify(doc);
    let records;
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return;
    }
    let r = records.find((x) => (x.text?.('plugin_id') || '').trim() === pluginId);
    if (!r) {
      let guid = null;
      try {
        guid = coll.createRecord?.(pluginId);
      } catch (_) {}
      if (guid) {
        for (let i = 0; i < 30; i++) {
          await new Promise((res) => setTimeout(res, i < 8 ? 100 : 200));
          try {
            const again = await coll.getAllRecords();
            r = again.find((x) => x.guid === guid) || again.find((x) => (x.text?.('plugin_id') || '').trim() === pluginId);
            if (r) break;
          } catch (_) {}
        }
      }
    }
    if (!r) return;
    try {
      const pId = r.prop?.('plugin_id');
      if (pId && typeof pId.set === 'function') pId.set(pluginId);
    } catch (_) {}
    try {
      const pj = r.prop?.('settings_json');
      if (pj && typeof pj.set === 'function') pj.set(json);
    } catch (_) {}
  }

  function showFirstRunDialog(ui, label, preferred, onPick) {
    const id = 'thymerext-pathb-first-' + Math.random().toString(36).slice(2);
    const box = document.createElement('div');
    box.id = id;
    box.style.cssText =
      'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;padding:16px;';
    const card = document.createElement('div');
    card.style.cssText =
      'max-width:420px;width:100%;background:var(--panel-bg-color,#1d1915);border:1px solid var(--border-default,#3f3f46);border-radius:12px;padding:20px;box-shadow:0 8px 32px rgba(0,0,0,0.5);';
    const title = document.createElement('div');
    title.textContent = label + ' — where to store settings?';
    title.style.cssText = 'font-weight:700;font-size:15px;margin-bottom:10px;';
    const hint = document.createElement('div');
    hint.textContent = 'Change later via Command Palette → “Storage location…”';
    hint.style.cssText = 'font-size:12px;color:var(--text-muted,#888);margin-bottom:16px;line-height:1.45;';
    const mk = (t, sub, prim) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.cssText =
        'display:block;width:100%;text-align:left;padding:12px 14px;margin-bottom:10px;border-radius:8px;cursor:pointer;font-size:14px;border:1px solid var(--border-default,#3f3f46);background:' +
        (prim ? 'rgba(167,139,250,0.25)' : 'transparent') +
        ';color:inherit;';
      const x = document.createElement('div');
      x.textContent = t;
      x.style.fontWeight = '600';
      b.appendChild(x);
      if (sub) {
        const s = document.createElement('div');
        s.textContent = sub;
        s.style.cssText = 'font-size:11px;opacity:0.75;margin-top:4px;line-height:1.35;';
        b.appendChild(s);
      }
      return b;
    };
    const bLoc = mk('This device only', 'Browser localStorage only.', preferred === 'local');
    const bSyn = mk('Sync via Plugin Settings', 'Workspace collection “' + COL_NAME + '”.', preferred === 'synced');
    const fin = (m) => {
      try {
        box.remove();
      } catch (_) {}
      onPick(m);
    };
    bLoc.addEventListener('click', () => fin('local'));
    bSyn.addEventListener('click', () => fin('synced'));
    card.appendChild(title);
    card.appendChild(hint);
    card.appendChild(bLoc);
    card.appendChild(bSyn);
    box.appendChild(card);
    document.body.appendChild(box);
  }

  g.ThymerExtPathB = {
    COL_NAME,
    enqueue,
    async init(opts) {
      const { plugin, pluginId, modeKey, mirrorKeys, label, data, ui } = opts;
      let mode = null;
      try {
        mode = localStorage.getItem(modeKey);
      } catch (_) {}

      const remote = await readDoc(data, pluginId);
      if (!mode && remote && (remote.storageMode === 'synced' || remote.storageMode === 'local')) {
        mode = remote.storageMode;
        try {
          localStorage.setItem(modeKey, mode);
        } catch (_) {}
      }

      if (!mode) {
        const coll = await findColl(data);
        const preferred = coll ? 'synced' : 'local';
        await new Promise((outerResolve) => {
          enqueue(async () => {
            const picked = await new Promise((r) => {
              showFirstRunDialog(ui, label, preferred, r);
            });
            try {
              localStorage.setItem(modeKey, picked);
            } catch (_) {}
            outerResolve(picked);
          });
        });
        try {
          mode = localStorage.getItem(modeKey);
        } catch (_) {}
      }

      plugin._pathBMode = mode === 'synced' ? 'synced' : 'local';
      plugin._pathBPluginId = pluginId;
      const keys = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;

      if (plugin._pathBMode === 'synced' && remote && remote.payload && typeof remote.payload === 'object') {
        for (const k of keys) {
          const v = remote.payload[k];
          if (typeof v === 'string') {
            try {
              localStorage.setItem(k, v);
            } catch (_) {}
          }
        }
      }

      if (plugin._pathBMode === 'synced') {
        try {
          await g.ThymerExtPathB.flushNow(data, pluginId, keys);
        } catch (_) {}
      }
    },

    scheduleFlush(plugin, mirrorKeys) {
      if (plugin._pathBMode !== 'synced') return;
      const keys = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      if (plugin._pathBFlushTimer) clearTimeout(plugin._pathBFlushTimer);
      plugin._pathBFlushTimer = setTimeout(() => {
        plugin._pathBFlushTimer = null;
        const data = plugin.data;
        const pid = plugin._pathBPluginId;
        if (!pid || !data) return;
        g.ThymerExtPathB.flushNow(data, pid, keys).catch((e) => console.error('[ThymerExtPathB] flush', e));
      }, 500);
    },

    async flushNow(data, pluginId, mirrorKeys) {
      const keys = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      const payload = {};
      for (const k of keys) {
        try {
          const v = localStorage.getItem(k);
          if (v !== null) payload[k] = v;
        } catch (_) {}
      }
      const doc = {
        v: 1,
        storageMode: 'synced',
        updatedAt: new Date().toISOString(),
        payload,
      };
      await writeDoc(data, pluginId, doc);
    },

    async openStorageDialog(opts) {
      const { plugin, pluginId, modeKey, mirrorKeys, label, data, ui } = opts;
      const cur = plugin._pathBMode === 'synced' ? 'synced' : 'local';
      const pick = await new Promise((resolve) => {
        const close = (v) => {
          try {
            box.remove();
          } catch (_) {}
          resolve(v);
        };
        const box = document.createElement('div');
        box.style.cssText =
          'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;padding:16px;';
        box.addEventListener('click', (e) => {
          if (e.target === box) close(null);
        });
        const card = document.createElement('div');
        card.style.cssText =
          'max-width:400px;width:100%;background:var(--panel-bg-color,#1d1915);border:1px solid var(--border-default,#3f3f46);border-radius:12px;padding:18px;';
        card.addEventListener('click', (e) => e.stopPropagation());
        const t = document.createElement('div');
        t.textContent = label + ' — storage';
        t.style.cssText = 'font-weight:700;margin-bottom:12px;';
        const b1 = document.createElement('button');
        b1.type = 'button';
        b1.textContent = 'This device only';
        const b2 = document.createElement('button');
        b2.type = 'button';
        b2.textContent = 'Sync via Plugin Settings';
        [b1, b2].forEach((b) => {
          b.style.cssText =
            'display:block;width:100%;padding:10px 12px;margin-bottom:8px;border-radius:8px;cursor:pointer;border:1px solid var(--border-default,#3f3f46);background:transparent;color:inherit;text-align:left;';
        });
        b1.addEventListener('click', () => close('local'));
        b2.addEventListener('click', () => close('synced'));
        const bx = document.createElement('button');
        bx.type = 'button';
        bx.textContent = 'Cancel';
        bx.style.cssText =
          'margin-top:8px;padding:8px 14px;border-radius:8px;cursor:pointer;border:1px solid var(--border-default,#3f3f46);background:transparent;color:inherit;';
        bx.addEventListener('click', () => close(null));
        card.appendChild(t);
        card.appendChild(b1);
        card.appendChild(b2);
        card.appendChild(bx);
        box.appendChild(card);
        document.body.appendChild(box);
      });
      if (!pick || pick === cur) return;
      try {
        localStorage.setItem(modeKey, pick);
      } catch (_) {}
      plugin._pathBMode = pick === 'synced' ? 'synced' : 'local';
      const keys = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      if (pick === 'synced') await g.ThymerExtPathB.flushNow(data, pluginId, keys);
      ui.addToaster?.({
        title: label,
        message: 'Storage: ' + (pick === 'synced' ? 'synced' : 'local only'),
        dismissible: true,
        autoDestroyTime: 3500,
      });
    },
  };

})(typeof globalThis !== 'undefined' ? globalThis : window);
// @generated END thymer-ext-path-b

/*
  SIDEBAR  : ⚡ Quick Note
  CMD+K    : "Quick Note" | "Quick Note: Configure"

  Journal reference insertion is intentionally omitted — Today's Notes
  footer surfaces records automatically based on their When date.

  CONFIG stored in localStorage "qn_config_v2"
  TEMPLATES stored in a collection named "Quick Note Templates"
*/

const QN_STORAGE_KEY    = 'qn_config_v2';
const QN_TEMPLATES_COLL = 'Quick Note Templates';

class Plugin extends AppPlugin {

  async onLoad() {
    await (globalThis.ThymerExtPathB?.init?.({
      plugin: this,
      pluginId: 'quick-notes',
      modeKey: 'thymerext_ps_mode_quick_notes',
      mirrorKeys: () => [QN_STORAGE_KEY],
      label: 'Quick Note',
      data: this.data,
      ui: this.ui,
    }) ?? (console.warn('[Quick Note] ThymerExtPathB runtime missing (redeploy full plugin .js from repo).'), Promise.resolve()));
    this._eventHandlerIds = [];
    this._running         = false; // guard against double-trigger
    this._config          = this._loadConfig();

    this.ui.registerCustomPanelType('qn-configure', (panel) => {
      this._mountConfigPanel(panel);
    });

    this.ui.addSidebarItem({
      icon: 'ti-bolt', label: 'Quick Note', tooltip: 'Create a timestamped note',
      onClick: () => this.run(),
    });
    this.ui.addCommandPaletteCommand({
      label: 'Quick Note', icon: 'ti-bolt', onSelected: () => this.run(),
    });
    this.ui.addCommandPaletteCommand({
      label: 'Quick Note: Configure', icon: 'ti-settings',
      onSelected: () => this.openConfigPanel(),
    });
    this.ui.addCommandPaletteCommand({
      label: 'Insert Template Here', icon: 'ti-template',
      onSelected: () => this._insertTemplateAtCursor(),
    });
    this.ui.addCommandPaletteCommand({
      label: 'Quick Note: Storage location…',
      icon: 'ti-database',
      onSelected: () => {
        globalThis.ThymerExtPathB?.openStorageDialog?.({
          plugin: this,
          pluginId: 'quick-notes',
          modeKey: 'thymerext_ps_mode_quick_notes',
          mirrorKeys: () => [QN_STORAGE_KEY],
          label: 'Quick Note',
          data: this.data,
          ui: this.ui,
        });
      },
    });
  }

  onUnload() {
    for (const id of (this._eventHandlerIds || [])) {
      try { this.events.off(id); } catch (_) {}
    }
    this._eventHandlerIds = [];
  }

  // =========================================================================
  // Config
  // =========================================================================

  _loadConfig() {
    try {
      const raw = localStorage.getItem(QN_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        for (const c of Object.values(parsed.collections || {})) {
          if (Array.isArray(c.fields))
            c.fields = c.fields.filter(f => f && f.length >= 2 && f !== '?');
          if (c.titleTemplate)
            c.titleTemplate = c.titleTemplate.replace(/,?\s*\{\?\}/g, '').trim();
        }
        return parsed;
      }
    } catch (_) {}
    return { collections: {} };
  }

  _saveConfig() {
    try { localStorage.setItem(QN_STORAGE_KEY, JSON.stringify(this._config)); } catch (_) {}
    globalThis.ThymerExtPathB?.scheduleFlush?.(this, () => [QN_STORAGE_KEY]);
  }

  // =========================================================================
  // Configure panel
  // =========================================================================

  async openConfigPanel() {
    const panel = await this.ui.createPanel();
    if (panel) panel.navigateToCustomType('qn-configure');
  }

  async _mountConfigPanel(panel) {
    const el = panel.getElement();
    if (!el) return;
    panel.setTitle('Quick Note — Configure');

    const allCollections  = await this.data.getAllCollections();
    const skip            = new Set(['journal', 'journals', QN_TEMPLATES_COLL.toLowerCase()]);
    const candidates      = allCollections.filter(c => !skip.has((c.getName() || '').toLowerCase()));
    const templatesColl   = allCollections.find(c => c.getName() === QN_TEMPLATES_COLL);
    const templateRecords = templatesColl ? await templatesColl.getAllRecords() : [];

    const collData = await Promise.all(candidates.map(async (coll) => {
      const name   = coll.getName() || '';
      const fields = await this._discoverFields(coll);
      const saved  = this._config.collections[name] || {};
      return {
        name, allFields: fields,
        enabled:        saved.enabled        || false,
        promptedFields: saved.fields         || [],
        fieldConfig:    saved.fieldConfig    || {},
        autoFillDate:   saved.autoFillDate   !== undefined ? saved.autoFillDate : 'When',
        promptDateIncludesTime: saved.promptDateIncludesTime === true,
        autoFillFields: saved.autoFillFields || [],
        titleTemplate:  saved.titleTemplate  || '{Date}. {Time}. {Collection}',
        templateGuid:   saved.templateGuid   || '',
      };
    }));

    const state      = collData.map(c => ({ ...c, promptedFields: [...c.promptedFields], fieldConfig: JSON.parse(JSON.stringify(c.fieldConfig)), autoFillFields: JSON.parse(JSON.stringify(c.autoFillFields)) }));
    let activeIndex  = null;

    const render = () => {
      el.innerHTML = '';
      el.style.cssText = 'padding:0;overflow:auto;height:100%;box-sizing:border-box;';

      const wrap = document.createElement('div');
      wrap.style.cssText = 'padding:24px;max-width:640px;margin:0 auto;display:flex;flex-direction:column;gap:16px;';

      // Header with export/import
      const topRow = document.createElement('div');
      topRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;';
      const hint = document.createElement('p');
      hint.textContent = 'Enable collections, configure prompted fields, title templates, and body templates.';
      hint.style.cssText = 'margin:0;color:var(--text-muted,#888);font-size:13px;flex:1;';
      const ioRow = document.createElement('div');
      ioRow.style.cssText = 'display:flex;gap:8px;flex-shrink:0;';
      const exportBtn = document.createElement('button');
      exportBtn.textContent = '⬆ Export'; exportBtn.style.cssText = this._btnStyle('secondary');
      exportBtn.addEventListener('click', () => this._exportConfig(exportBtn));
      const importBtn = document.createElement('button');
      importBtn.textContent = '⬇ Import'; importBtn.style.cssText = this._btnStyle('secondary');
      importBtn.addEventListener('click', () => this._showImportUI(wrap, render));
      ioRow.appendChild(exportBtn); ioRow.appendChild(importBtn);
      topRow.appendChild(hint); topRow.appendChild(ioRow);
      wrap.appendChild(topRow);

      if (!templatesColl) {
        const tmplHint = document.createElement('div');
        tmplHint.style.cssText = 'padding:10px 14px;border-radius:8px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.2);font-size:12px;color:var(--text-muted,#888);';
        tmplHint.innerHTML = `<strong style="color:#fbbf24;">Templates tip:</strong> Create a collection called <strong>"${QN_TEMPLATES_COLL}"</strong> and add template records there.`;
        wrap.appendChild(tmplHint);
      }

      state.forEach((item, idx) => {
        wrap.appendChild(this._renderCollCard(item, idx, activeIndex === idx, () => {
          activeIndex = activeIndex === idx ? null : idx;
          render();
        }, render, templateRecords));
      });

      const saveBtn = document.createElement('button');
      saveBtn.textContent = 'Save Settings';
      saveBtn.style.cssText = this._btnStyle('primary') + 'width:100%;padding:10px 0;font-size:14px;margin-top:8px;';
      saveBtn.addEventListener('click', () => {
        for (const item of state) {
          this._config.collections[item.name] = {
            enabled:       item.enabled,
            fields:        item.promptedFields,
            fieldConfig:   item.fieldConfig,
            autoFillDate:  item.autoFillDate,
            promptDateIncludesTime: item.promptDateIncludesTime === true,
            autoFillFields: item.autoFillFields,
            titleTemplate: item.titleTemplate,
            templateGuid:  item.templateGuid || '',
          };
        }
        this._saveConfig();
        this.ui.addToaster({ title: 'Saved', message: 'Quick Note settings saved.', dismissible: true, autoDestroyTime: 3000 });
      });
      wrap.appendChild(saveBtn);
      el.appendChild(wrap);
    };

    render();
  }

  // ── Export / Import ───────────────────────────────────────────────────────

  async _exportConfig(btn) {
    try {
      await navigator.clipboard.writeText(JSON.stringify(this._config, null, 2));
      const orig = btn.textContent;
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = orig; }, 2000);
    } catch (e) {
      this.ui.addToaster({ title: 'Export failed', message: e.message, dismissible: true });
    }
  }

  _showImportUI(wrap, rerender) {
    const existing = wrap.querySelector('.qn-import-ui');
    if (existing) { existing.remove(); return; }

    const box = document.createElement('div');
    box.className = 'qn-import-ui';
    box.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:14px;border-radius:10px;border:1px solid var(--border-default,#3f3f46);background:var(--bg-hover,rgba(255,255,255,0.03));';

    const lbl = document.createElement('div');
    lbl.textContent = 'Paste exported config JSON below:';
    lbl.style.cssText = 'font-size:13px;font-weight:600;';

    const ta = document.createElement('textarea');
    ta.placeholder = '{ "collections": { ... } }'; ta.rows = 6;
    ta.style.cssText = 'width:100%;padding:8px 10px;border-radius:6px;font-size:12px;font-family:monospace;background:var(--bg-default,#18181b);color:inherit;border:1px solid var(--border-default,#3f3f46);box-sizing:border-box;outline:none;resize:vertical;';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel'; cancelBtn.style.cssText = this._btnStyle('secondary');
    cancelBtn.addEventListener('click', () => box.remove());
    const applyBtn = document.createElement('button');
    applyBtn.textContent = 'Apply Import'; applyBtn.style.cssText = this._btnStyle('primary');
    applyBtn.addEventListener('click', () => {
      try {
        const parsed = JSON.parse(ta.value.trim());
        if (!parsed || typeof parsed.collections !== 'object') throw new Error('Invalid config — must have a "collections" key.');
        this._config = parsed;
        this._saveConfig();
        box.remove();
        this.ui.addToaster({ title: 'Imported', message: 'Config imported. Reloading…', dismissible: true, autoDestroyTime: 2000 });
        setTimeout(() => rerender(), 300);
      } catch (e) {
        this.ui.addToaster({ title: 'Import failed', message: e.message, dismissible: true });
      }
    });

    btnRow.appendChild(cancelBtn); btnRow.appendChild(applyBtn);
    box.appendChild(lbl); box.appendChild(ta); box.appendChild(btnRow);
    wrap.insertBefore(box, wrap.children[1]);
    ta.focus();
  }

  // ── Collection card ───────────────────────────────────────────────────────

  _renderCollCard(item, idx, isOpen, onToggleOpen, rerender, templateRecords) {
    const card = document.createElement('div');
    card.style.cssText = `border:1px solid ${item.enabled ? 'var(--color-primary-500,#a78bfa)' : 'var(--border-default,#3f3f46)'};border-radius:10px;overflow:hidden;background:${item.enabled ? 'rgba(167,139,250,0.07)' : 'var(--bg-hover,rgba(255,255,255,0.03))'};`;

    const hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px 16px;';
    const cb = document.createElement('input');
    cb.type='checkbox'; cb.checked=item.enabled;
    cb.style.cssText='width:16px;height:16px;flex-shrink:0;cursor:pointer;accent-color:var(--color-primary-500,#a78bfa);';
    cb.addEventListener('click', e => e.stopPropagation());
    cb.addEventListener('change', e => { e.stopPropagation(); item.enabled=cb.checked; rerender(); });
    const nameEl = document.createElement('span');
    nameEl.textContent=item.name; nameEl.style.cssText='font-weight:600;font-size:14px;flex:1;cursor:pointer;';
    nameEl.addEventListener('click', onToggleOpen);
    const chev = document.createElement('span');
    chev.textContent=isOpen?'▲':'▼'; chev.style.cssText='font-size:11px;color:var(--text-muted,#888);cursor:pointer;';
    chev.addEventListener('click', onToggleOpen);
    hdr.appendChild(cb); hdr.appendChild(nameEl); hdr.appendChild(chev);
    card.appendChild(hdr);

    if (!isOpen) return card;

    const body = document.createElement('div');
    body.style.cssText='padding:0 16px 16px;display:flex;flex-direction:column;gap:18px;border-top:1px solid var(--border-default,#3f3f46);padding-top:14px;';
    body.appendChild(this._renderFieldsSection(item, rerender));
    body.appendChild(this._renderAutoFillSection(item, rerender));
    body.appendChild(this._renderTitleSection(item));
    body.appendChild(this._renderTemplateSection(item, templateRecords));
    card.appendChild(body);
    return card;
  }

  _renderFieldsSection(item, rerender) {
    const sec = document.createElement('div');
    sec.appendChild(this._cfgLabel('Prompted Fields', 'Asked in order when creating a note'));

    item.promptedFields.forEach((fname, fi) => {
      const fconf = item.fieldConfig[fname] || {};
      const row = document.createElement('div');
      row.style.cssText='display:flex;align-items:flex-start;gap:10px;background:var(--bg-hover,rgba(255,255,255,0.04));border-radius:8px;padding:10px 12px;margin-bottom:6px;';
      const nspan = document.createElement('span');
      nspan.textContent=fname; nspan.style.cssText='font-weight:600;font-size:13px;flex:1;padding-top:3px;min-width:80px;';
      const cfg = document.createElement('div');
      cfg.style.cssText='display:flex;flex-direction:column;gap:6px;flex:2;';
      cfg.appendChild(this._miniRow('Type', this._miniSelect(['text','reference','choice','date'], fconf.type||'text', v => { item.fieldConfig[fname]=item.fieldConfig[fname]||{}; item.fieldConfig[fname].type=v; rerender(); })));
      if ((fconf.type||'text')==='date') cfg.appendChild(this._miniRow('Include time', this._miniCheckbox(!!fconf.dateIncludesTime, v => { item.fieldConfig[fname]=item.fieldConfig[fname]||{}; item.fieldConfig[fname].dateIncludesTime=v; })));
      if ((fconf.type||'text')==='reference') {
        cfg.appendChild(this._miniRow('Source collection', this._miniInput(fconf.sourceCollection||'People', v => { item.fieldConfig[fname]=item.fieldConfig[fname]||{}; item.fieldConfig[fname].sourceCollection=v; })));
        cfg.appendChild(this._miniRow('Allow multiple', this._miniCheckbox(!!fconf.referenceMultiple, v => { item.fieldConfig[fname]=item.fieldConfig[fname]||{}; item.fieldConfig[fname].referenceMultiple=v; })));
      }
      if ((fconf.type||'text')==='choice')    cfg.appendChild(this._miniRow('Choices (comma-sep)', this._miniInput((fconf.choices||[]).join(', '), v => { item.fieldConfig[fname]=item.fieldConfig[fname]||{}; item.fieldConfig[fname].choices=v.split(',').map(s=>s.trim()).filter(Boolean); })));
      const ord = document.createElement('div');
      ord.style.cssText='display:flex;flex-direction:column;gap:2px;flex-shrink:0;';
      ord.appendChild(this._tinyBtn('↑', fi===0, () => { [item.promptedFields[fi-1],item.promptedFields[fi]]=[item.promptedFields[fi],item.promptedFields[fi-1]]; rerender(); }));
      ord.appendChild(this._tinyBtn('↓', fi===item.promptedFields.length-1, () => { [item.promptedFields[fi+1],item.promptedFields[fi]]=[item.promptedFields[fi],item.promptedFields[fi+1]]; rerender(); }));
      const rm = document.createElement('button');
      rm.textContent='✕'; rm.style.cssText='background:none;border:none;color:var(--text-muted,#888);cursor:pointer;font-size:13px;padding:3px 0 0 4px;flex-shrink:0;';
      rm.addEventListener('click', () => { item.promptedFields.splice(fi,1); delete item.fieldConfig[fname]; rerender(); });
      row.appendChild(nspan); row.appendChild(cfg); row.appendChild(ord); row.appendChild(rm);
      sec.appendChild(row);
    });

    const addRow = document.createElement('div');
    addRow.style.cssText='display:flex;gap:8px;align-items:center;margin-top:2px;';
    const addSel = document.createElement('select');
    addSel.style.cssText='flex:1;padding:6px 8px;border-radius:6px;font-size:13px;background:var(--bg-default,#18181b);color:inherit;border:1px solid var(--border-default,#3f3f46);';
    const blankO=document.createElement('option'); blankO.value=''; blankO.textContent='— add a field —'; addSel.appendChild(blankO);
    for (const f of item.allFields) {
      if (!item.promptedFields.includes(f.name)) { const o=document.createElement('option'); o.value=f.name; o.textContent=`${f.name} (${f.type})`; addSel.appendChild(o); }
    }
    const custO=document.createElement('option'); custO.value='__custom__'; custO.textContent='✏ Type a field name…'; addSel.appendChild(custO);
    const custInp=document.createElement('input');
    custInp.type='text'; custInp.placeholder='Field name';
    custInp.style.cssText='flex:1;padding:6px 8px;border-radius:6px;font-size:13px;background:var(--bg-default,#18181b);color:inherit;border:1px solid var(--border-default,#3f3f46);outline:none;display:none;';
    addSel.addEventListener('change', () => { custInp.style.display=addSel.value==='__custom__'?'block':'none'; });
    const addBtn=document.createElement('button');
    addBtn.textContent='Add'; addBtn.style.cssText=this._btnStyle('primary')+'padding:6px 16px;font-size:13px;';
    addBtn.addEventListener('click', () => {
      const n=addSel.value==='__custom__'?custInp.value.trim():addSel.value;
      if (!n||n==='__custom__'||n.length<2) return;
      if (!item.promptedFields.includes(n)) item.promptedFields.push(n);
      rerender();
    });
    addRow.appendChild(addSel); addRow.appendChild(custInp); addRow.appendChild(addBtn);
    sec.appendChild(addRow);
    return sec;
  }

  _renderAutoFillSection(item, rerender) {
    const sec = document.createElement('div');

    // Date field auto-fill
    sec.appendChild(this._cfgLabel('Date Field', 'Auto-filled with today\'s date on creation (skipped if this field is also listed under Prompted Fields — you\'ll get a calendar instead)'));

    const dateRow = document.createElement('div');
    dateRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:16px;';

    const dateSel = document.createElement('select');
    dateSel.style.cssText = 'flex:1;padding:6px 8px;border-radius:6px;font-size:13px;background:var(--bg-default,#18181b);color:inherit;border:1px solid var(--border-default,#3f3f46);';

    const disabledOpt = document.createElement('option');
    disabledOpt.value = '';
    disabledOpt.textContent = '— disabled —';
    dateSel.appendChild(disabledOpt);

    for (const f of item.allFields) {
      const o = document.createElement('option');
      o.value = f.name;
      o.textContent = `${f.name} (${f.type})`;
      if (f.name === item.autoFillDate) o.selected = true;
      dateSel.appendChild(o);
    }

    const custDateOpt = document.createElement('option');
    custDateOpt.value = '__custom__';
    custDateOpt.textContent = '✏ Custom field…';
    dateSel.appendChild(custDateOpt);

    const custDateInp = document.createElement('input');
    custDateInp.type = 'text';
    custDateInp.placeholder = 'Field name';
    custDateInp.style.cssText = 'flex:1;padding:6px 8px;border-radius:6px;font-size:13px;background:var(--bg-default,#18181b);color:inherit;border:1px solid var(--border-default,#3f3f46);outline:none;display:none;';
    custDateInp.value = item.autoFillDate && !item.allFields.some(f => f.name === item.autoFillDate) ? item.autoFillDate : '';
    if (custDateInp.value) dateSel.value = '__custom__';
    custDateInp.addEventListener('input', () => { item.autoFillDate = custDateInp.value.trim(); });

    dateSel.addEventListener('change', () => {
      if (dateSel.value === '__custom__') {
        custDateInp.style.display = 'block';
        custDateInp.focus();
        item.autoFillDate = custDateInp.value.trim();
      } else {
        custDateInp.style.display = 'none';
        item.autoFillDate = dateSel.value;
      }
    });

    dateRow.appendChild(dateSel);
    dateRow.appendChild(custDateInp);
    sec.appendChild(dateRow);

    const timeDefaultRow = document.createElement('div');
    timeDefaultRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap;';
    const timeDefaultCb = document.createElement('input');
    timeDefaultCb.type = 'checkbox';
    timeDefaultCb.id = `qn-prompt-time-${item.name}`;
    timeDefaultCb.checked = item.promptDateIncludesTime === true;
    timeDefaultCb.style.cssText = 'width:16px;height:16px;cursor:pointer;accent-color:var(--color-primary-500,#a78bfa);flex-shrink:0;';
    timeDefaultCb.addEventListener('change', () => { item.promptDateIncludesTime = timeDefaultCb.checked; });
    const timeDefaultLbl = document.createElement('label');
    timeDefaultLbl.htmlFor = timeDefaultCb.id;
    timeDefaultLbl.textContent = 'Include time in date prompt (default)';
    timeDefaultLbl.style.cssText = 'font-size:13px;cursor:pointer;user-select:none;';
    const timeDefaultHint = document.createElement('span');
    timeDefaultHint.textContent = 'When the field type does not force date-only or date+time, the calendar dialog starts with or without time; you can still change it there.';
    timeDefaultHint.style.cssText = 'font-size:11px;color:var(--text-muted,#888);width:100%;';
    timeDefaultRow.appendChild(timeDefaultCb);
    timeDefaultRow.appendChild(timeDefaultLbl);
    sec.appendChild(timeDefaultRow);
    sec.appendChild(timeDefaultHint);

    // Other auto-fill fields
    sec.appendChild(this._cfgLabel('Other Auto-Fill Fields', 'Set on record creation without prompting (supports {Date}, {Time}, {Collection} tokens)'));

    item.autoFillFields.forEach((af, afi) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:flex-start;gap:10px;background:var(--bg-hover,rgba(255,255,255,0.04));border-radius:8px;padding:10px 12px;margin-bottom:6px;';

      const nspan = document.createElement('span');
      nspan.textContent = af.name;
      nspan.style.cssText = 'font-weight:600;font-size:13px;flex:1;padding-top:3px;min-width:80px;';

      const valInp = document.createElement('input');
      valInp.type = 'text';
      valInp.value = af.value;
      valInp.placeholder = 'Value or {Date}/{Time}/{Collection}';
      valInp.style.cssText = 'flex:1.5;padding:3px 7px;border-radius:4px;font-size:12px;background:var(--bg-default,#18181b);color:inherit;border:1px solid var(--border-default,#3f3f46);outline:none;';
      valInp.addEventListener('input', () => { item.autoFillFields[afi].value = valInp.value; });

      const ord = document.createElement('div');
      ord.style.cssText = 'display:flex;flex-direction:column;gap:2px;flex-shrink:0;';
      ord.appendChild(this._tinyBtn('↑', afi === 0, () => { [item.autoFillFields[afi-1], item.autoFillFields[afi]] = [item.autoFillFields[afi], item.autoFillFields[afi-1]]; rerender(); }));
      ord.appendChild(this._tinyBtn('↓', afi === item.autoFillFields.length - 1, () => { [item.autoFillFields[afi+1], item.autoFillFields[afi]] = [item.autoFillFields[afi], item.autoFillFields[afi+1]]; rerender(); }));

      const rm = document.createElement('button');
      rm.textContent = '✕';
      rm.style.cssText = 'background:none;border:none;color:var(--text-muted,#888);cursor:pointer;font-size:13px;padding:3px 0 0 4px;flex-shrink:0;';
      rm.addEventListener('click', () => { item.autoFillFields.splice(afi, 1); rerender(); });

      row.appendChild(nspan);
      row.appendChild(valInp);
      row.appendChild(ord);
      row.appendChild(rm);
      sec.appendChild(row);
    });

    // Add button for new auto-fill field
    const addRow = document.createElement('div');
    addRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:2px;';

    const addSel = document.createElement('select');
    addSel.style.cssText = 'flex:1;padding:6px 8px;border-radius:6px;font-size:13px;background:var(--bg-default,#18181b);color:inherit;border:1px solid var(--border-default,#3f3f46);';
    const blankO = document.createElement('option');
    blankO.value = '';
    blankO.textContent = '— add a field —';
    addSel.appendChild(blankO);
    for (const f of item.allFields) {
      if (!item.autoFillFields.some(af => af.name === f.name)) {
        const o = document.createElement('option');
        o.value = f.name;
        o.textContent = `${f.name} (${f.type})`;
        addSel.appendChild(o);
      }
    }
    const custO = document.createElement('option');
    custO.value = '__custom__';
    custO.textContent = '✏ Type a field name…';
    addSel.appendChild(custO);

    const custInp = document.createElement('input');
    custInp.type = 'text';
    custInp.placeholder = 'Field name';
    custInp.style.cssText = 'flex:1;padding:6px 8px;border-radius:6px;font-size:13px;background:var(--bg-default,#18181b);color:inherit;border:1px solid var(--border-default,#3f3f46);outline:none;display:none;';

    const valInp = document.createElement('input');
    valInp.type = 'text';
    valInp.placeholder = 'Value';
    valInp.style.cssText = 'flex:1;padding:6px 8px;border-radius:6px;font-size:13px;background:var(--bg-default,#18181b);color:inherit;border:1px solid var(--border-default,#3f3f46);outline:none;';

    addSel.addEventListener('change', () => {
      custInp.style.display = addSel.value === '__custom__' ? 'block' : 'none';
      if (addSel.value === '__custom__') custInp.focus();
    });

    const addBtn = document.createElement('button');
    addBtn.textContent = 'Add';
    addBtn.style.cssText = this._btnStyle('primary') + 'padding:6px 16px;font-size:13px;flex-shrink:0;';
    addBtn.addEventListener('click', () => {
      const n = addSel.value === '__custom__' ? custInp.value.trim() : addSel.value;
      const v = valInp.value.trim();
      if (!n || n === '__custom__' || n.length < 2) return;
      if (!item.autoFillFields.some(af => af.name === n)) {
        item.autoFillFields.push({ name: n, value: v });
        rerender();
      }
    });

    addRow.appendChild(addSel);
    addRow.appendChild(custInp);
    addRow.appendChild(valInp);
    addRow.appendChild(addBtn);
    sec.appendChild(addRow);

    return sec;
  }

  _renderTitleSection(item) {
    const sec = document.createElement('div');
    const tokens = ['{Date}','{Time}','{Collection}',...item.promptedFields.map(f=>`{${f}}`)];
    sec.appendChild(this._cfgLabel('Title Template', `Tokens: ${tokens.join(' ')}`));
    const tmpl=document.createElement('input');
    tmpl.type='text'; tmpl.value=item.titleTemplate;
    tmpl.style.cssText='width:100%;padding:8px 10px;border-radius:6px;font-size:13px;background:var(--bg-default,#18181b);color:inherit;border:1px solid var(--border-default,#3f3f46);box-sizing:border-box;outline:none;font-family:monospace;';
    tmpl.addEventListener('input', () => { item.titleTemplate=tmpl.value; });
    const chips=document.createElement('div');
    chips.style.cssText='display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;';
    for (const tok of tokens) {
      const chip=document.createElement('button');
      chip.textContent=tok; chip.style.cssText='padding:3px 10px;border-radius:12px;font-size:11px;cursor:pointer;background:var(--bg-hover,rgba(255,255,255,0.06));border:1px solid var(--border-default,#3f3f46);color:inherit;';
      chip.addEventListener('click', () => { const pos=tmpl.selectionStart??tmpl.value.length; item.titleTemplate=tmpl.value.slice(0,pos)+tok+tmpl.value.slice(pos); tmpl.value=item.titleTemplate; tmpl.focus(); tmpl.setSelectionRange(pos+tok.length,pos+tok.length); });
      chips.appendChild(chip);
    }
    sec.appendChild(tmpl); sec.appendChild(chips);
    return sec;
  }

  _renderTemplateSection(item, templateRecords) {
    const sec = document.createElement('div');
    sec.appendChild(this._cfgLabel('Body Template', `Pick a record from "${QN_TEMPLATES_COLL}" — its content is copied into every new note`));
    const sel=document.createElement('select');
    sel.style.cssText='width:100%;padding:8px 10px;border-radius:6px;font-size:13px;background:var(--bg-default,#18181b);color:inherit;border:1px solid var(--border-default,#3f3f46);';
    const noneOpt=document.createElement('option'); noneOpt.value=''; noneOpt.textContent='— no template —'; sel.appendChild(noneOpt);
    for (const rec of templateRecords) {
      const opt=document.createElement('option'); opt.value=rec.guid; opt.textContent=rec.getName()||'Untitled';
      if (rec.guid===item.templateGuid) opt.selected=true; sel.appendChild(opt);
    }
    if (templateRecords.length===0) { const d=document.createElement('option'); d.disabled=true; d.textContent=`(create "${QN_TEMPLATES_COLL}" collection first)`; sel.appendChild(d); }
    sel.addEventListener('change', () => { item.templateGuid=sel.value; });
    const tokenNote=document.createElement('div');
    tokenNote.style.cssText='font-size:11px;color:var(--text-muted,#888);margin-top:6px;font-family:monospace;';
    tokenNote.textContent='Tokens work in template text too: {Date} {Time} {Collection} '+(item.promptedFields.length?item.promptedFields.map(f=>`{${f}}`).join(' '):'{FieldName}');
    sec.appendChild(sel); sec.appendChild(tokenNote);
    return sec;
  }

  // =========================================================================
  // Main run flow
  // =========================================================================

  async run() {
    // Guard against double-trigger from rapid sidebar clicks
    if (this._running) return;
    this._running = true;
    try {
      const allCollections = await this.data.getAllCollections();
      const eligible       = this._getEnabledCollections(allCollections);

      if (eligible.length === 0) {
        this.ui.addToaster({ title: 'No collections configured', message: 'Use "Quick Note: Configure" in the command palette.', dismissible: true, autoDestroyTime: 5000 });
        return;
      }

      const chosen = await this._pickFromDropdown(
        eligible.map(c => ({ label: c.getName(), value: c })),
        'Search collections…'
      );
      if (!chosen) return;

      const collName     = chosen.getName();
      const collConfig   = chosen.getConfiguration?.() || {};
      const collSingular = collConfig.item_name || collConfig.itemName || collConfig.custom?.item_name || collName.replace(/s$/i, '');
      const conf         = this._config.collections[collName] || {};
      const promptedFields = conf.fields || [];
      const titleTemplate  = conf.titleTemplate || '{Date}. {Time}. {Collection}';
      const templateGuid   = conf.templateGuid  || '';
      const discoveredFields = await this._discoverFields(chosen);
      const fieldMetaByName  = Object.fromEntries(discoveredFields.map(f => [f.name, f]));

      // Prompt each field
      const fieldValues = {};
      for (const fieldName of promptedFields) {
        const value = await this._promptField(
          fieldName,
          conf.fieldConfig?.[fieldName] || {},
          allCollections,
          fieldMetaByName[fieldName],
          conf
        );
        if (value === null) return;
        fieldValues[fieldName] = value;
      }

      // Build token map
      const now     = new Date();
      const yyyy    = now.getFullYear();
      const mm      = String(now.getMonth() + 1).padStart(2, '0');
      const dd      = String(now.getDate()).padStart(2, '0');
      const hh      = String(now.getHours()).padStart(2, '0');
      const min     = String(now.getMinutes()).padStart(2, '0');
      const dateStr = `${yyyy}.${mm}.${dd}`;
      const timeStr = `${hh}:${min}`;

      const tokens = { '{Date}': dateStr, '{Time}': timeStr, '{Collection}': collSingular };
      for (const [fname, val] of Object.entries(fieldValues)) {
        tokens[`{${fname}}`] = val.displayValue || '';
      }

      // Build title
      let title = titleTemplate;
      for (const [tok, val] of Object.entries(tokens)) title = title.split(tok).join(val);

      // Create record
      const newGuid = chosen.createRecord(title);
      if (!newGuid) { this.ui.addToaster({ title: 'Error', message: 'Failed to create record.', dismissible: true }); return; }

      await this._sleep(200);
      const allRecords = await chosen.getAllRecords();
      const record     = allRecords.find(r => r.guid === newGuid);

      if (record) {
        // Auto-fill date field (skip if user prompts for that field — calendar sets it later)
        const autoFillDate = conf.autoFillDate !== undefined ? conf.autoFillDate : 'When';
        const dateFieldPrompted = autoFillDate && promptedFields.includes(autoFillDate);
        if (autoFillDate && !dateFieldPrompted) {
          try {
            const prop = record.prop(autoFillDate);
            if (prop) {
              if (typeof DateTime !== 'undefined') prop.set(new DateTime(now).value());
              else prop.set(now);
            }
          } catch (_) {}
        }

        // Auto-fill other fields
        for (const af of (conf.autoFillFields || [])) {
          let resolved = af.value;
          for (const [tok, val] of Object.entries(tokens)) resolved = resolved.split(tok).join(val);
          try {
            const prop = record.prop(af.name);
            if (prop && resolved !== '') prop.set(resolved);
          } catch (_) {}
        }

        for (const [fname, val] of Object.entries(fieldValues)) {
          try {
            const prop = record.prop(fname);
            if (!prop) continue;
            if (val.multi === true && Array.isArray(val.guids) && val.guids.length > 0) {
              this._setMultiReference(prop, val.guids);
              continue;
            }
            if (val.guid !== undefined && val.guid !== null) {
              prop.set(val.guid);
              continue;
            }
            if (val.dateValue instanceof Date && !isNaN(val.dateValue.getTime())) {
              const isDt = val.isDateTime === true;
              if (isDt) {
                if (typeof DateTime !== 'undefined') prop.set(new DateTime(val.dateValue).value());
                else prop.set(val.dateValue);
              } else {
                const d = val.dateValue;
                if (typeof DateTime !== 'undefined') {
                  prop.set(DateTime.dateOnly(d.getFullYear(), d.getMonth(), d.getDate()).value());
                } else {
                  prop.set(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0));
                }
              }
              continue;
            }
            const setVal = val.displayValue;
            if (setVal !== null && setVal !== undefined && setVal !== '') prop.set(setVal);
          } catch (_) {}
        }
      }

      // Navigate to new record, then apply template if configured
      this._navigateTo(newGuid);
      if (templateGuid) {
        await this._sleep(250); // give the record time to be available in data API
        await this._applyTemplate(templateGuid, newGuid, tokens, allCollections);
      }

    } catch (e) {
      console.error('[QuickNote]', e);
      this.ui.addToaster({ title: 'Error', message: e.message, dismissible: true });
    } finally {
      this._running = false;
    }
  }

  // =========================================================================
  // Insert template at cursor
  // =========================================================================

  async _insertTemplateAtCursor() {
    try {
      const panel = this.ui.getActivePanel();
      if (!panel) {
        this.ui.addToaster({ title: 'No active note', message: 'Open a note first.', dismissible: true });
        return;
      }

      const record = panel.getActiveRecord();
      if (!record) {
        this.ui.addToaster({ title: 'No active note', message: 'Open a note first.', dismissible: true });
        return;
      }

      const allCollections = await this.data.getAllCollections();
      const templatesColl = allCollections.find(c => c.getName() === QN_TEMPLATES_COLL);
      if (!templatesColl) {
        this.ui.addToaster({ title: 'No templates', message: `Create a "${QN_TEMPLATES_COLL}" collection first.`, dismissible: true });
        return;
      }

      const templateRecords = await templatesColl.getAllRecords();
      if (templateRecords.length === 0) {
        this.ui.addToaster({ title: 'No templates', message: `Add templates to the "${QN_TEMPLATES_COLL}" collection.`, dismissible: true });
        return;
      }

      const options = templateRecords.map(r => ({ label: r.getName() || 'Untitled', value: r.guid }));
      const selectedGuid = await this._pickFromDropdown(
        options.map(opt => ({ label: opt.label, value: opt.value })),
        'Search templates…'
      );

      if (!selectedGuid) return;

      await this._insertTemplateIntoRecord(record, selectedGuid, allCollections);
    } catch (e) {
      console.error('[QuickNote] Insert template error:', e);
      this.ui.addToaster({ title: 'Error', message: e.message, dismissible: true });
    }
  }

  async _insertTemplateIntoRecord(record, templateGuid, allCollections) {
    try {
      const templatesColl = allCollections.find(c => c.getName() === QN_TEMPLATES_COLL);
      if (!templatesColl) return;

      const templateRecords = await templatesColl.getAllRecords();
      const templateRecord = templateRecords.find(r => r.guid === templateGuid);
      if (!templateRecord) return;

      const linesToClone = await templateRecord.getLineItems();
      if (!linesToClone || linesToClone.length === 0) return;

      // Build token map with current date/time
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const hh = String(now.getHours()).padStart(2, '0');
      const min = String(now.getMinutes()).padStart(2, '0');
      const dateStr = `${yyyy}.${mm}.${dd}`;
      const timeStr = `${hh}:${min}`;

      const tokens = { '{Date}': dateStr, '{Time}': timeStr, '{Collection}': record.getName() || '' };

      // Clone root-level lines from template
      const rootLines = linesToClone.filter(l => l.parent_guid === templateRecord.guid);
      let after = null;
      for (const line of rootLines) {
        const result = await this._cloneLine(record, line, after, null, tokens);
        after = result.line;
      }

      this.ui.addToaster({ title: 'Template inserted', message: 'Template lines added to note.', dismissible: true, autoDestroyTime: 3000 });
    } catch (e) {
      console.error('[QuickNote] Template insert error:', e);
      throw e;
    }
  }

  // =========================================================================
  // Template application
  // =========================================================================

  async _applyTemplate(templateGuid, recordGuid, tokens, allCollections) {
    try {
      const templatesColl   = allCollections.find(c => c.getName() === QN_TEMPLATES_COLL);
      if (!templatesColl) return;
      const templateRecords = await templatesColl.getAllRecords();
      const templateRecord  = templateRecords.find(r => r.guid === templateGuid);
      if (!templateRecord) return;

      const linesToClone = await templateRecord.getLineItems();
      if (!linesToClone || linesToClone.length === 0) return;

      // Get the record directly by GUID instead of relying on panel's active record cache
      let activeRecord = null;
      for (let i = 0; i < 20; i++) {
        activeRecord = this.data.getRecord(recordGuid);
        if (activeRecord) break;
        await this._sleep(100);
      }
      if (!activeRecord) return;

      const rootLines = linesToClone.filter(l => l.parent_guid === templateRecord.guid);
      let after = null;
      for (const line of rootLines) {
        const result = await this._cloneLine(activeRecord, line, after, null, tokens);
        after = result.line;
      }
    } catch (e) {
      console.error('[QuickNote] Template apply error:', e);
    }
  }

  async _cloneLine(activeRecord, lineToClone, after, parent, tokens) {
    const isBr = lineToClone.type === 'br';
    const type  = lineToClone.type || 'text';

    let line = null;
    try {
      line = await activeRecord.createLineItem(parent, after, type);
    } catch (_) {
      if (!isBr) {
        try { line = await activeRecord.createLineItem(parent, after, 'text'); } catch (_) {}
      }
    }

    if (isBr) return { line: line || after };
    if (!line) return { line: after };

    try { if (lineToClone.getTaskStatus?.())       await line.setTaskStatus?.(lineToClone.getTaskStatus()); }       catch (_) {}
    try { if (lineToClone.getBlockStyle?.())        line.setBlockStyle?.(lineToClone.getBlockStyle()); }            catch (_) {}
    try { if (lineToClone.getHeadingSize?.())       line.setHeadingSize?.(lineToClone.getHeadingSize()); }          catch (_) {}
    try { if (lineToClone.getHighlightLanguage?.()) line.setHighlightLanguage?.(lineToClone.getHighlightLanguage()); } catch (_) {}
    try { if (lineToClone.getIcon?.())              line.setIcon?.(lineToClone.getIcon()); }                        catch (_) {}
    try { if (lineToClone.getLinkStyle?.())         line.setLinkStyle?.(lineToClone.getLinkStyle()); }              catch (_) {}
    try { if (lineToClone.props)                    line.setMetaProperties?.(lineToClone.props); }                  catch (_) {}

    if (lineToClone.segments) {
      const newSegments = lineToClone.segments.map(seg => {
        if (seg.type === 'text' || seg.type === 'bold' || seg.type === 'italic') {
          let text = typeof seg.text === 'string' ? seg.text : '';
          for (const [tok, val] of Object.entries(tokens)) text = text.split(tok).join(val);
          return { ...seg, text };
        }
        return seg;
      });
      line.setSegments(newSegments);
    }

    if (lineToClone.children?.length > 0) {
      let childAfter = null;
      for (const child of lineToClone.children) {
        const result = await this._cloneLine(activeRecord, child, childAfter, line, tokens);
        childAfter = result.line;
      }
    }

    return { line };
  }

  // =========================================================================
  // Pickers
  // =========================================================================

  _setMultiReference(prop, guids) {
    if (!guids || guids.length === 0) return;
    if (guids.length === 1) {
      try { prop.set(guids[0]); } catch (_) {}
      return;
    }
    try {
      prop.set(guids);
      return;
    } catch (_) {}
    try {
      prop.set(JSON.stringify(guids));
      return;
    } catch (_) {}
    try {
      prop.set(guids.join(','));
    } catch (_) {}
  }

  _promptReferenceMulti(fieldName, records) {
    return new Promise((resolve) => {
      const panel = this.ui.getActivePanel();
      let left = Math.round(window.innerWidth / 2) - 190;
      let top  = Math.round(window.innerHeight / 5);
      if (panel) {
        const el = panel.getElement();
        if (el) {
          const r = el.getBoundingClientRect();
          left = Math.round(r.left + r.width / 2) - 190;
          top  = Math.round(r.top + 60);
        }
      }
      const box = document.createElement('div');
      box.style.cssText = this._qnFrostedPromptShellStyle(Math.max(12, left), Math.max(12, top), 380)
        + 'max-height:min(420px,calc(100vh - 24px));padding:14px;box-sizing:border-box;';
      const lbl = document.createElement('div');
      lbl.textContent = fieldName + ' (select any, then OK)';
      lbl.style.cssText = 'font-weight:600;font-size:14px;';
      const search = document.createElement('input');
      search.type = 'text';
      search.placeholder = 'Filter records…';
      search.style.cssText = 'width:100%;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.16);background:rgba(8,8,12,0.34);color:inherit;font-size:13px;box-sizing:border-box;outline:none;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);';
      const listWrap = document.createElement('div');
      listWrap.style.cssText = 'flex:1;min-height:120px;max-height:260px;overflow:auto;border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:4px 2px;background:rgba(6,6,10,0.24);';
      const selected = new Map();
      const sorted = () => [...records].sort((a, b) => (a.getName() || '').localeCompare(b.getName() || '', undefined, { sensitivity: 'base' }));
      const renderList = () => {
        listWrap.innerHTML = '';
        const q = (search.value || '').trim().toLowerCase();
        for (const r of sorted()) {
          const name = r.getName() || 'Untitled';
          if (q && !name.toLowerCase().includes(q)) continue;
          const row = document.createElement('label');
          row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:4px;cursor:pointer;font-size:13px;';
          row.addEventListener('mouseenter', () => { row.style.background = 'var(--bg-hover,rgba(255,255,255,0.06))'; });
          row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = selected.has(r.guid);
          cb.style.cssText = 'width:15px;height:15px;flex-shrink:0;cursor:pointer;accent-color:var(--color-primary-500,#a78bfa);';
          cb.addEventListener('change', () => {
            if (cb.checked) selected.set(r.guid, name);
            else selected.delete(r.guid);
          });
          const span = document.createElement('span');
          span.textContent = name;
          span.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
          row.appendChild(cb);
          row.appendChild(span);
          listWrap.appendChild(row);
        }
        if (!listWrap.children.length) {
          const empty = document.createElement('div');
          empty.textContent = records.length ? 'No matches.' : 'No records in source collection.';
          empty.style.cssText = 'padding:12px;color:var(--text-muted,#888);font-size:13px;text-align:center;';
          listWrap.appendChild(empty);
        }
      };
      search.addEventListener('input', renderList);
      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-shrink:0;';
      const skipBtn = document.createElement('button');
      skipBtn.textContent = 'Skip';
      skipBtn.style.cssText = this._btnStyle('secondary');
      const okBtn = document.createElement('button');
      okBtn.textContent = 'OK';
      okBtn.style.cssText = this._btnStyle('primary');
      btnRow.appendChild(skipBtn);
      btnRow.appendChild(okBtn);
      box.appendChild(lbl);
      box.appendChild(search);
      box.appendChild(listWrap);
      box.appendChild(btnRow);
      document.body.appendChild(box);
      renderList();
      let resolved = false;
      const done = (val) => {
        if (resolved) return;
        resolved = true;
        box.remove();
        resolve(val);
      };
      okBtn.addEventListener('click', () => {
        const guids = [...selected.keys()];
        const names = guids.map((g) => selected.get(g));
        done({ displayValue: names.join(', '), guids, multi: true });
      });
      skipBtn.addEventListener('click', () => done({ displayValue: '', guids: [], multi: true }));
      search.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          done(null);
        }
      });
      const onOut = (e) => {
        if (!box.contains(e.target)) {
          document.removeEventListener('pointerdown', onOut, true);
          done(null);
        }
      };
      document.addEventListener('pointerdown', onOut, true);
      requestAnimationFrame(() => search.focus());
    });
  }

  _pickFromDropdown(options, placeholder) {
    return new Promise((resolve) => {
      const panel = this.ui.getActivePanel();
      const { left, top } = this._qnPromptShellPosition(panel);
      const box = document.createElement('div');
      box.style.cssText = this._qnFrostedPromptShellStyle(Math.max(12, left), Math.max(12, top), 360)
        + 'max-height:min(460px,calc(100vh - 24px));padding:14px;box-sizing:border-box;';

      const search = document.createElement('input');
      search.type = 'text';
      search.placeholder = placeholder || 'Search...';
      search.style.cssText = 'width:100%;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.16);background:rgba(8,8,12,0.34);color:inherit;font-size:13px;box-sizing:border-box;outline:none;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);';

      const listWrap = document.createElement('div');
      listWrap.style.cssText = 'flex:1;min-height:140px;max-height:280px;overflow:auto;border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:4px 2px;background:rgba(6,6,10,0.24);';

      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-shrink:0;';
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.style.cssText = this._btnStyle('secondary');
      btnRow.appendChild(cancelBtn);

      box.appendChild(search);
      box.appendChild(listWrap);
      box.appendChild(btnRow);
      document.body.appendChild(box);

      let resolved = false;
      let filtered = options.slice();
      let activeIndex = 0;

      const done = (val) => {
        if (resolved) return;
        resolved = true;
        document.removeEventListener('pointerdown', onOut, true);
        box.remove();
        resolve(val);
      };

      const renderList = () => {
        listWrap.innerHTML = '';
        const q = (search.value || '').trim().toLowerCase();
        filtered = options.filter(opt => !q || (opt.label || '').toLowerCase().includes(q));
        if (activeIndex >= filtered.length) activeIndex = Math.max(0, filtered.length - 1);

        filtered.forEach((opt, idx) => {
          const row = document.createElement('button');
          row.type = 'button';
          row.textContent = opt.label;
          row.style.cssText = 'display:block;width:100%;text-align:left;padding:7px 10px;border:0;background:transparent;color:inherit;border-radius:6px;cursor:pointer;font-size:13px;';
          if (idx === activeIndex) row.style.background = 'rgba(255,255,255,0.12)';
          row.addEventListener('mouseenter', () => {
            activeIndex = idx;
            renderList();
          });
          row.addEventListener('click', () => done(opt.value));
          listWrap.appendChild(row);
        });

        if (!filtered.length) {
          const empty = document.createElement('div');
          empty.textContent = 'No matches.';
          empty.style.cssText = 'padding:12px;color:var(--text-muted,#888);font-size:13px;text-align:center;';
          listWrap.appendChild(empty);
        }
      };

      search.addEventListener('input', () => {
        activeIndex = 0;
        renderList();
      });
      search.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (filtered.length) activeIndex = Math.min(filtered.length - 1, activeIndex + 1);
          renderList();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (filtered.length) activeIndex = Math.max(0, activeIndex - 1);
          renderList();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (filtered[activeIndex]) done(filtered[activeIndex].value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          done(null);
        }
      });

      cancelBtn.addEventListener('click', () => done(null));
      const onOut = (e) => {
        if (!box.contains(e.target)) done(null);
      };
      document.addEventListener('pointerdown', onOut, true);

      renderList();
      requestAnimationFrame(() => search.focus());
    });
  }

  _shouldPromptWithDatePicker(fieldName, fieldConf, fieldMeta, conf) {
    const t = fieldConf.type || 'text';
    if (t === 'date') return true;
    const st = fieldMeta?.type || '';
    if (st === 'date' || st === 'datetime') return true;
    const auto = conf.autoFillDate !== undefined ? conf.autoFillDate : 'When';
    return !!auto && fieldName === auto;
  }

  /**
   * Thymer often labels "When"-style fields as schema type `datetime`, but users still want
   * date-only prompts. Only true date-only schema fields lock the UI; everything else follows
   * per-field Type → Include time, or the collection "Include time in date prompt (default)" setting.
   */
  _datePromptTimeMode(fieldConf, fieldMeta, conf) {
    const st = fieldMeta?.type || '';
    if (st === 'date') {
      return { includeTime: false, locked: 'date' };
    }
    let includeTime = false;
    if ((fieldConf.type || 'text') === 'date') {
      includeTime = fieldConf.dateIncludesTime === true;
    } else {
      includeTime = conf.promptDateIncludesTime === true;
    }
    return { includeTime, locked: null };
  }

  async _promptField(fieldName, fieldConf, allCollections, fieldMeta, conf) {
    if (this._shouldPromptWithDatePicker(fieldName, fieldConf, fieldMeta, conf)) {
      return this._promptDate(fieldName, fieldConf, fieldMeta, conf);
    }
    const type = fieldConf.type || 'text';
    if (type === 'reference') {
      const sourceColl = allCollections.find(c => c.getName() === (fieldConf.sourceCollection || 'People'));
      const records    = sourceColl ? await sourceColl.getAllRecords() : [];
      if (fieldConf.referenceMultiple === true) {
        return this._promptReferenceMulti(fieldName, records);
      }
      const options    = records.map(r => ({ label: r.getName()||'Untitled', value: { displayValue: r.getName()||'Untitled', guid: r.guid } }));
      options.push({ label: '— Skip —', value: { displayValue: '', guid: undefined } });
      return this._pickFromDropdown(options, `Search ${fieldName}…`);
    }
    if (type === 'choice') {
      const options = (fieldConf.choices||[]).map(c => ({ label: c, value: { displayValue: c, guid: undefined } }));
      options.push({ label: '— Skip —', value: { displayValue: '', guid: undefined } });
      return this._pickFromDropdown(options, `Choose ${fieldName}…`);
    }
    return this._promptText(fieldName);
  }

  _formatDateParts(d) {
    const yyyy = d.getFullYear();
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const dd   = String(d.getDate()).padStart(2, '0');
    const hh   = String(d.getHours()).padStart(2, '0');
    const min  = String(d.getMinutes()).padStart(2, '0');
    return { dateStr: `${yyyy}.${mm}.${dd}`, timeStr: `${hh}:${min}` };
  }

  _parseDateInputValue(inp) {
    if (!inp.value) return null;
    if (inp.type === 'datetime-local') {
      const d = new Date(inp.value);
      return isNaN(d.getTime()) ? null : d;
    }
    const parts = inp.value.split('-').map(Number);
    if (parts.length < 3 || parts.some(n => Number.isNaN(n))) return null;
    const [y, m, day] = parts;
    return new Date(y, m - 1, day, 12, 0, 0);
  }

  _fillDateInput(inp, d, includeTime) {
    const pad = (n) => String(n).padStart(2, '0');
    if (!d || isNaN(d.getTime())) return;
    if (includeTime) {
      inp.type = 'datetime-local';
      inp.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } else {
      inp.type = 'date';
      inp.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
  }

  _qnPromptShellPosition(panel) {
    let left = Math.round(window.innerWidth / 2) - 175;
    let top  = Math.round(window.innerHeight / 3);
    if (panel) {
      const el = panel.getElement();
      if (el) {
        const r = el.getBoundingClientRect();
        left = Math.round(r.left + r.width / 2) - 175;
        top  = Math.round(r.top + 80);
      }
    }
    return { left, top };
  }

  _qnThemeRgb(varName, fallbackHex) {
    const val = (getComputedStyle(document.documentElement).getPropertyValue(varName) || '').trim() || fallbackHex;
    const m = val.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (!m) return '24,24,34';
    return `${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)}`;
  }

  /** Frosted panel styling aligned with workspace transparency and command palette tones. */
  _qnFrostedPromptShellStyle(left, top, width = 350) {
    const panelRgb = this._qnThemeRgb('--color-bg-900', '#11111b');
    const cmdpalRgb = this._qnThemeRgb('--color-bg-700', '#1e1e2e');
    return `position:fixed;left:${left}px;top:${top}px;width:${width}px;`
      + `background:linear-gradient(180deg,rgba(${cmdpalRgb},0.70),rgba(${panelRgb},0.62));`
      + `backdrop-filter:blur(16px) saturate(1.28);-webkit-backdrop-filter:blur(16px) saturate(1.28);`
      + `border:1px solid rgba(255,255,255,0.14);border-radius:12px;`
      + `box-shadow:var(--cmdpal-box-shadow,0 12px 40px rgba(0,0,0,0.45));`
      + `padding:16px;z-index:99999;display:flex;flex-direction:column;gap:10px;`;
  }

  _promptDate(fieldName, fieldConf, fieldMeta, conf) {
    return new Promise((resolve) => {
      const { includeTime: initialInclude, locked } = this._datePromptTimeMode(fieldConf, fieldMeta, conf);
      let includeTime = initialInclude;

      const panel = this.ui.getActivePanel();
      const { left, top } = this._qnPromptShellPosition(panel);
      const box = document.createElement('div');
      box.style.cssText = this._qnFrostedPromptShellStyle(left, top);
      const lbl = document.createElement('div');
      lbl.textContent = fieldName;
      lbl.style.cssText = 'font-weight:600;font-size:14px;';

      const inp = document.createElement('input');
      const now = new Date();
      this._fillDateInput(inp, now, includeTime);
      inp.style.cssText = 'width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border-default,#3f3f46);background:var(--input-bg-color,#181511);color:inherit;font-size:14px;box-sizing:border-box;outline:none;';

      let timeRow = null;
      if (!locked) {
        timeRow = document.createElement('label');
        timeRow.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;user-select:none;';
        const timeCb = document.createElement('input');
        timeCb.type = 'checkbox';
        timeCb.checked = includeTime;
        timeCb.style.cssText = 'width:16px;height:16px;cursor:pointer;accent-color:var(--color-primary-500,#a78bfa);flex-shrink:0;';
        const timeLbl = document.createElement('span');
        timeLbl.textContent = 'Include time';
        timeRow.appendChild(timeCb);
        timeRow.appendChild(timeLbl);
        timeCb.addEventListener('change', () => {
          const cur = this._parseDateInputValue(inp) || now;
          includeTime = timeCb.checked;
          this._fillDateInput(inp, cur, includeTime);
          inp.focus();
        });
      }

      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
      const skipBtn = document.createElement('button');
      skipBtn.textContent = 'Skip';
      skipBtn.style.cssText = this._btnStyle('secondary');
      const okBtn = document.createElement('button');
      okBtn.textContent = 'OK';
      okBtn.style.cssText = this._btnStyle('primary');
      btnRow.appendChild(skipBtn);
      btnRow.appendChild(okBtn);
      box.appendChild(lbl);
      if (timeRow) box.appendChild(timeRow);
      box.appendChild(inp);
      box.appendChild(btnRow);
      document.body.appendChild(box);
      let resolved = false;
      const done = (val) => {
        if (resolved) return;
        resolved = true;
        box.remove();
        resolve(val);
      };
      const commit = () => {
        const useTime = locked === 'date' ? false : includeTime;
        let raw = inp.value;
        if (!raw || !String(raw).trim()) {
          this._fillDateInput(inp, new Date(), useTime);
          raw = inp.value;
        }
        let d;
        if (useTime) {
          d = new Date(raw);
        } else {
          const parts = String(raw).split('-').map(Number);
          if (parts.length < 3 || parts.some(n => Number.isNaN(n))) {
            done({ displayValue: '', guid: undefined });
            return;
          }
          const [y, m, day] = parts;
          d = new Date(y, m - 1, day, 12, 0, 0);
        }
        if (isNaN(d.getTime())) {
          done({ displayValue: '', guid: undefined });
          return;
        }
        const { dateStr, timeStr } = this._formatDateParts(d);
        const displayValue = useTime ? `${dateStr} ${timeStr}` : dateStr;
        done({ displayValue, guid: undefined, dateValue: d, isDateTime: useTime });
      };
      okBtn.addEventListener('click', () => commit());
      skipBtn.addEventListener('click', () => done({ displayValue: '', guid: undefined }));
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          done(null);
        }
      });
      const onOut = (e) => {
        if (!box.contains(e.target)) {
          document.removeEventListener('pointerdown', onOut, true);
          done(null);
        }
      };
      document.addEventListener('pointerdown', onOut, true);
      requestAnimationFrame(() => inp.focus());
    });
  }

  _promptText(fieldName) {
    return new Promise((resolve) => {
      const panel = this.ui.getActivePanel();
      const { left, top } = this._qnPromptShellPosition(panel);
      const box = document.createElement('div');
      box.style.cssText = this._qnFrostedPromptShellStyle(left, top);
      const lbl=document.createElement('div'); lbl.textContent=fieldName; lbl.style.cssText='font-weight:600;font-size:14px;';
      const inp=document.createElement('input'); inp.type='text'; inp.placeholder=`Enter ${fieldName}…`;
      inp.style.cssText='width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border-default,#3f3f46);background:var(--input-bg-color,#181511);color:inherit;font-size:14px;box-sizing:border-box;outline:none;';
      const btnRow=document.createElement('div'); btnRow.style.cssText='display:flex;gap:8px;justify-content:flex-end;';
      const skipBtn=document.createElement('button'); skipBtn.textContent='Skip'; skipBtn.style.cssText=this._btnStyle('secondary');
      const okBtn=document.createElement('button'); okBtn.textContent='OK'; okBtn.style.cssText=this._btnStyle('primary');
      btnRow.appendChild(skipBtn); btnRow.appendChild(okBtn);
      box.appendChild(lbl); box.appendChild(inp); box.appendChild(btnRow);
      document.body.appendChild(box);
      let resolved=false;
      const done=(val)=>{ if (resolved) return; resolved=true; box.remove(); resolve(val); };
      okBtn.addEventListener('click', ()=>done({displayValue:inp.value.trim(),guid:undefined}));
      skipBtn.addEventListener('click', ()=>done({displayValue:'',guid:undefined}));
      inp.addEventListener('keydown', (e)=>{ e.stopPropagation(); if (e.key==='Enter'){e.preventDefault();done({displayValue:inp.value.trim(),guid:undefined});} if (e.key==='Escape'){e.preventDefault();done(null);} });
      const onOut=(e)=>{ if (!box.contains(e.target)){document.removeEventListener('pointerdown',onOut,true);done(null);} };
      document.addEventListener('pointerdown',onOut,true);
      requestAnimationFrame(()=>inp.focus());
    });
  }

  // =========================================================================
  // Utilities
  // =========================================================================

  _getEnabledCollections(allCollections) {
    const skip = new Set(['journal','journals']);
    return allCollections.filter(c => {
      if (skip.has((c.getName()||'').toLowerCase())) return false;
      return this._config.collections[c.getName()]?.enabled === true;
    });
  }

  _setWhenField(record, date) {
    for (const name of ['When','when','Date','date']) {
      try {
        const prop = record.prop(name);
        if (!prop) continue;
        if (typeof DateTime !== 'undefined') prop.set(new DateTime(date).value());
        else prop.set(date);
        return;
      } catch (_) {}
    }
  }

  async _discoverFields(coll) {
    try {
      const config = coll.getConfiguration?.() || {};
      const fields = config.fields || [];
      if (fields.length > 0) return fields.filter(f=>!f.read_only).map(f=>({name:f.label||f.id||'',type:f.type||'text'})).filter(f=>f.name.length>=2&&f.name!=='?');
    } catch (_) {}
    return [];
  }

  _navigateTo(guid) {
    const panel = this.ui.getActivePanel();
    if (!panel) return;
    panel.navigateTo({ workspaceGuid: this.getWorkspaceGuid(), type: 'edit_panel', rootId: guid, subId: guid });
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── UI helpers ──────────────────────────────────────────────────────────

  _btnStyle(v) {
    if (v==='primary')   return 'padding:7px 18px;background:var(--color-primary-500,#a78bfa);color:#fff;border:none;border-radius:7px;font-weight:700;font-size:13px;cursor:pointer;';
    if (v==='secondary') return 'padding:7px 14px;background:transparent;color:inherit;border:1px solid var(--border-default,#3f3f46);border-radius:7px;font-size:13px;cursor:pointer;';
    return '';
  }

  _cfgLabel(title, subtitle) {
    const wrap=document.createElement('div'); wrap.style.cssText='margin-bottom:8px;';
    const t=document.createElement('div'); t.textContent=title; t.style.cssText='font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-muted,#8a7e6a);margin-bottom:3px;'; wrap.appendChild(t);
    if (subtitle) { const s=document.createElement('div'); s.textContent=subtitle; s.style.cssText='font-size:11px;color:var(--text-muted,#8a7e6a);font-family:monospace;word-break:break-all;'; wrap.appendChild(s); }
    return wrap;
  }

  _miniRow(label, control) {
    const row=document.createElement('div'); row.style.cssText='display:flex;align-items:center;gap:8px;';
    const lbl=document.createElement('span'); lbl.textContent=label; lbl.style.cssText='font-size:11px;color:var(--text-muted,#8a7e6a);min-width:100px;flex-shrink:0;';
    row.appendChild(lbl); row.appendChild(control); return row;
  }

  _miniSelect(options, current, onChange) {
    const sel=document.createElement('select'); sel.style.cssText='padding:3px 6px;border-radius:4px;font-size:12px;background:var(--bg-default,#18181b);color:inherit;border:1px solid var(--border-default,#3f3f46);';
    for (const o of options) { const opt=document.createElement('option'); opt.value=o; opt.textContent=o; if (o===current) opt.selected=true; sel.appendChild(opt); }
    sel.addEventListener('change',()=>onChange(sel.value)); return sel;
  }

  _miniInput(value, onChange) {
    const inp=document.createElement('input'); inp.type='text'; inp.value=value;
    inp.style.cssText='flex:1;padding:3px 7px;border-radius:4px;font-size:12px;background:var(--bg-default,#18181b);color:inherit;border:1px solid var(--border-default,#3f3f46);outline:none;';
    inp.addEventListener('input',()=>onChange(inp.value)); return inp;
  }

  _miniCheckbox(checked, onChange) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.style.cssText = 'width:16px;height:16px;cursor:pointer;accent-color:var(--color-primary-500,#a78bfa);';
    cb.addEventListener('change', () => onChange(cb.checked));
    return cb;
  }

  _tinyBtn(text, disabled, onClick) {
    const btn=document.createElement('button'); btn.textContent=text; btn.disabled=disabled;
    btn.style.cssText=`background:none;border:none;cursor:${disabled?'default':'pointer'};font-size:11px;padding:2px 4px;opacity:${disabled?'0.3':'1'};color:inherit;`;
    if (!disabled) btn.addEventListener('click',onClick); return btn;
  }
}