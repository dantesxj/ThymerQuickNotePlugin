// ==Plugin==
// name: Prompt+
// description: Create a timestamped note in any configured collection
// icon: ti-message-plus
// ==/Plugin==



// @generated BEGIN thymer-plugin-settings (source: plugins/plugin-settings/ThymerPluginSettingsRuntime.js — run: npm run embed-plugin-settings)
/**
 * ThymerPluginSettings — workspace **Plugin Backend** collection + optional localStorage mirror
 * for global plugins that do not own a collection. (Legacy name **Plugin Settings** is still found until renamed.)
 *
 * Edit this file, then from repo root: npm run embed-plugin-settings
 *
 * Debug: console filter `[ThymerExt/PluginBackend]`. To silence:
 *   localStorage.setItem('thymerext_debug_collections', '0'); location.reload();
 *
 * Rows:
 * - **Vault** (`record_kind` = `vault`): one per `plugin_id` — holds synced localStorage payload JSON.
 * - **Other rows** (`record_kind` = `log`, `config`, …): same **Plugin** field (`plugin`) for filtering;
 *   use a **distinct** `plugin_id` per row (e.g. `habit-tracker:log:2026-04-24`) so vault lookup stays unambiguous.
 *
 * API: ThymerPluginSettings.init({ plugin, pluginId, modeKey, mirrorKeys, label, data, ui })
 *      ThymerPluginSettings.scheduleFlush(plugin, mirrorKeys)
 *      ThymerPluginSettings.flushNow(data, pluginId, mirrorKeys)
 *      ThymerPluginSettings.openStorageDialog({ plugin, pluginId, modeKey, mirrorKeys, label, data, ui })
 *      ThymerPluginSettings.listRows(data, { pluginSlug, recordKind? })
 *      ThymerPluginSettings.createDataRow(data, { pluginSlug, recordKind, rowPluginId, recordTitle?, settingsDoc? })
 *      ThymerPluginSettings.upgradeCollectionSchema(data) — merge missing `plugin` / `record_kind` fields into existing collection
 *      ThymerPluginSettings.registerPluginSlug(data, { slug, label? }) — ensure `plugin` choice includes this slug (call once per plugin)
 */
(function pluginSettingsRuntime(g) {
  if (g.ThymerPluginSettings) return;

  const COL_NAME = 'Plugin Backend';
  const COL_NAME_LEGACY = 'Plugin Settings';
  const KIND_VAULT = 'vault';
  const FIELD_PLUGIN = 'plugin';
  const FIELD_KIND = 'record_kind';
  const q = [];
  let busy = false;

  /**
   * Collection ensure diagnostics (read browser console for `[ThymerExt/PluginBackend]`.
   * Disable: `localStorage.setItem('thymerext_debug_collections','0')` then reload.
   */
  const DEBUG_COLLECTIONS = (() => {
    try {
      const o = localStorage.getItem('thymerext_debug_collections');
      if (o === '0' || o === 'off' || o === 'false') return false;
    } catch (_) {}
    return true;
  })();
  const DEBUG_PATHB_ID =
    'pb-' + (Date.now() & 0xffffffff).toString(16) + '-' + Math.random().toString(36).slice(2, 7);

  /** If true, Thymer ignores programmatic field updates — force off on every schema save. */
  const MANAGED_UNLOCK = { fields: false, views: false, sidebar: false };

  /**
   * Ensure Plugin Backend collection without duplicate `createCollection` calls.
   * Sibling **plugin iframes** are often not `window` siblings — walking `parent` can stop at
   * each plugin’s *own* frame, so a promise on “hierarchy best” is **not** one shared object.
   * **`window.top` is the same** for all same-tab iframes and, when not cross-origin, is the
   * one place to attach a cross-iframe lock. Fallback: walk the parent chain for opaque frames.
   */
  function getSharedDeduplicationWindow() {
    try {
      if (typeof window === 'undefined') return g;
      const t = window.top;
      if (t) {
        void t.document;
        return t;
      }
    } catch (_) {
      /* cross-origin top */
    }
    try {
      let w = typeof window !== 'undefined' ? window : null;
      let best = w || g;
      while (w) {
        try {
          void w.document;
          best = w;
        } catch (_) {
          break;
        }
        if (w === w.top) break;
        w = w.parent;
      }
      return best;
    } catch (_) {
      return typeof window !== 'undefined' ? window : g;
    }
  }

  const PB_ENSURE_GLOBAL_P = '__thymerPluginBackendEnsureGlobalP';
  const SERIAL_DATA_CREATE_P = '__thymerExtSerializedDataCreateP_v1';
  /** `getAllCollections` can briefly return [] (host UI / race) after a valid non-empty read — refuse create in that window. */
  const GETALL_COLLECTIONS_SANITY = '__thymerExtGetAllCollectionsSanityV1';
  function touchGetAllSanityFromCount(len) {
    const n = Number(len) || 0;
    const h = getSharedDeduplicationWindow();
    if (!h[GETALL_COLLECTIONS_SANITY]) h[GETALL_COLLECTIONS_SANITY] = { nLast: 0, tLast: 0 };
    const s = h[GETALL_COLLECTIONS_SANITY];
    if (n > 0) {
      s.nLast = n;
      s.tLast = Date.now();
    }
  }
  function isSuspiciousEmptyAfterRecentNonEmptyList(currentLen) {
    const c = Number(currentLen) || 0;
    if (c > 0) {
      touchGetAllSanityFromCount(c);
      return false;
    }
    const h = getSharedDeduplicationWindow();
    const s = h[GETALL_COLLECTIONS_SANITY];
    if (!s || s.nLast <= 0 || !s.tLast) return false;
    return Date.now() - s.tLast < 60_000;
  }

  function chainPluginBackendEnsure(data, work) {
    const root = getSharedDeduplicationWindow();
    try {
      if (!root[PB_ENSURE_GLOBAL_P]) root[PB_ENSURE_GLOBAL_P] = Promise.resolve();
    } catch (_) {
      return Promise.resolve().then(work);
    }
    root[PB_ENSURE_GLOBAL_P] = root[PB_ENSURE_GLOBAL_P].catch(() => {}).then(work);
    return root[PB_ENSURE_GLOBAL_P];
  }

  function withUnlockedManaged(base) {
    return { ...(base && typeof base === 'object' ? base : {}), managed: MANAGED_UNLOCK };
  }

  /** Index of the “Plugin” column (`id` **plugin**, or legacy label match). */
  function findPluginColumnFieldIndex(fields) {
    const arr = Array.isArray(fields) ? fields : [];
    let i = arr.findIndex((f) => f && f.id === FIELD_PLUGIN);
    if (i >= 0) return i;
    i = arr.findIndex(
      (f) =>
        f &&
        String(f.label || '')
          .trim()
          .toLowerCase() === 'plugin' &&
        (f.type === 'text' || f.type === 'plaintext' || f.type === 'string')
    );
    return i;
  }

  /** Keep internal column identity when replacing field shape (text → choice). */
  function copyStableFieldKeys(prev, next) {
    if (!prev || !next || typeof prev !== 'object' || typeof next !== 'object') return;
    for (const k of ['guid', 'colguid', 'colGuid', 'field_guid']) {
      if (prev[k] != null && next[k] == null) next[k] = prev[k];
    }
  }

  function getPluginFieldDef(coll) {
    if (!coll || typeof coll.getConfiguration !== 'function') return null;
    try {
      const fields = coll.getConfiguration()?.fields || [];
      const i = findPluginColumnFieldIndex(fields);
      return i >= 0 ? fields[i] : null;
    } catch (_) {
      return null;
    }
  }

  function pluginColumnPropId(coll, requestedId) {
    if (requestedId !== FIELD_PLUGIN || !coll) return requestedId;
    const f = getPluginFieldDef(coll);
    return (f && f.id) || FIELD_PLUGIN;
  }

  function cloneFieldDef(f) {
    if (!f || typeof f !== 'object') return f;
    try {
      return structuredClone(f);
    } catch (_) {
      try {
        return JSON.parse(JSON.stringify(f));
      } catch (__) {
        return { ...f };
      }
    }
  }

  const PLUGIN_SETTINGS_SHAPE = {
    ver: 1,
    name: COL_NAME,
    icon: 'ti-adjustments',
    color: null,
    home: false,
    page_field_ids: [FIELD_PLUGIN, FIELD_KIND, 'plugin_id', 'created_at', 'updated_at', 'settings_json'],
    item_name: 'Setting, Config, or Log',
    description: 'Workspace storage for plugins: Use the Plugin column to filter by plugin.',
    show_sidebar_items: true,
    show_cmdpal_items: false,
    fields: [
      {
        icon: 'ti-apps',
        id: FIELD_PLUGIN,
        label: 'Plugin',
        type: 'choice',
        read_only: false,
        active: true,
        many: false,
        choices: [
          { id: 'quick-notes', label: 'quick-notes', color: '0', active: true },
          { id: 'habit-tracker', label: 'Habit Tracker', color: '0', active: true },
          { id: 'ynab', label: 'ynab', color: '0', active: true },
        ],
      },
      {
        icon: 'ti-category',
        id: FIELD_KIND,
        label: 'Record kind',
        type: 'text',
        read_only: false,
        active: true,
        many: false,
      },
      {
        icon: 'ti-id',
        id: 'plugin_id',
        label: 'Plugin ID',
        type: 'text',
        read_only: false,
        active: true,
        many: false,
      },
      {
        icon: 'ti-clock-plus',
        id: 'created_at',
        label: 'Created',
        many: false,
        read_only: true,
        active: true,
        type: 'datetime',
      },
      {
        icon: 'ti-clock-edit',
        id: 'updated_at',
        label: 'Modified',
        many: false,
        read_only: true,
        active: true,
        type: 'datetime',
      },
      {
        icon: 'ti-code',
        id: 'settings_json',
        label: 'Settings JSON',
        type: 'text',
        read_only: false,
        active: true,
        many: false,
      },
      {
        icon: 'ti-abc',
        id: 'title',
        label: 'Title',
        many: false,
        read_only: false,
        active: true,
        type: 'text',
      },
      {
        icon: 'ti-photo',
        id: 'banner',
        label: 'Banner',
        many: false,
        read_only: false,
        active: true,
        type: 'banner',
      },
      {
        icon: 'ti-align-left',
        id: 'icon',
        label: 'Icon',
        many: false,
        read_only: false,
        active: true,
        type: 'text',
      },
    ],
    sidebar_record_sort_dir: 'desc',
    sidebar_record_sort_field_id: 'updated_at',
    managed: { fields: false, views: false, sidebar: false },
    custom: {},
    views: [
      {
        id: 'V0YBPGDDZ0MHRSQ',
        shown: true,
        icon: 'ti-table',
        label: 'All',
        description: '',
        field_ids: ['title', FIELD_PLUGIN, FIELD_KIND, 'plugin_id', 'created_at', 'updated_at'],
        type: 'table',
        read_only: false,
        group_by_field_id: null,
        sort_dir: 'desc',
        sort_field_id: 'updated_at',
        opts: {},
      },
      {
        id: 'VPGAWVGVKZD57C9',
        shown: true,
        icon: 'ti-layout-kanban',
        label: 'By Plugin...',
        description: '',
        field_ids: ['title', FIELD_KIND, 'created_at', 'updated_at'],
        type: 'board',
        read_only: false,
        group_by_field_id: FIELD_PLUGIN,
        sort_dir: 'desc',
        sort_field_id: 'updated_at',
        opts: {},
      },
    ],
  };

  function cloneShape() {
    try {
      return structuredClone(PLUGIN_SETTINGS_SHAPE);
    } catch (_) {
      return JSON.parse(JSON.stringify(PLUGIN_SETTINGS_SHAPE));
    }
  }

  /** Append default views from the canonical shape when the workspace collection is missing them (by view `id`). */
  function mergeViewsArray(baseViews, desiredViews) {
    const desired = Array.isArray(desiredViews) ? desiredViews.map((v) => cloneFieldDef(v)) : [];
    const cur = Array.isArray(baseViews) ? baseViews.map((v) => cloneFieldDef(v)) : [];
    if (cur.length === 0) {
      return { views: desired, changed: desired.length > 0 };
    }
    const ids = new Set(cur.map((v) => v && v.id).filter(Boolean));
    let changed = false;
    for (const v of desired) {
      if (v && v.id && !ids.has(v.id)) {
        cur.push(cloneFieldDef(v));
        ids.add(v.id);
        changed = true;
      }
    }
    return { views: cur, changed };
  }

  /** Slug before first colon, else whole id (e.g. `habit-tracker:log:2026-04-24` → `habit-tracker`). */
  function inferPluginSlugFromPid(pid) {
    if (!pid) return '';
    const s = String(pid).trim();
    const i = s.indexOf(':');
    if (i <= 0) return s;
    return s.slice(0, i);
  }

  function inferRecordKindFromPid(pid, slug) {
    if (!pid || !slug) return '';
    const p = String(pid);
    if (p === slug) return KIND_VAULT;
    if (p === `${slug}:config`) return 'config';
    if (p.startsWith(`${slug}:log:`)) return 'log';
    return '';
  }

  function colorForSlug(slug) {
    const colors = ['0', '1', '2', '3', '4', '5', '6', '7'];
    let h = 0;
    const s = String(slug || '');
    for (let i = 0; i < s.length; i++) h = (h + s.charCodeAt(i) * (i + 1)) % colors.length;
    return colors[h];
  }

  /** Normalize Thymer choice option (object or legacy string). */
  function normalizeChoiceOption(c) {
    if (c == null) return null;
    if (typeof c === 'string') {
      const s = c.trim();
      if (!s) return null;
      return { id: s, label: s, color: colorForSlug(s), active: true };
    }
    const id = String(c.id ?? c.label ?? '')
      .trim();
    if (!id) return null;
    return {
      id,
      label: String(c.label ?? id).trim() || id,
      color: String(c.color != null ? c.color : colorForSlug(id)),
      active: c.active !== false,
    };
  }

  /**
   * Fresh choice field object (no legacy keys). Thymer often ignores `type` changes when merging
   * onto an existing text field’s full config — same pattern as markdown importer choice fields.
   */
  function cleanPluginChoiceField(prev, desiredPlugin, choicesList) {
    const fieldId = (prev && prev.id) || FIELD_PLUGIN;
    const next = {
      id: fieldId,
      label: (prev && prev.label) || desiredPlugin.label || 'Plugin',
      icon: (prev && prev.icon) || desiredPlugin.icon || 'ti-apps',
      type: 'choice',
      many: false,
      read_only: false,
      active: prev ? prev.active !== false : true,
      choices: Array.isArray(choicesList) ? choicesList : [],
    };
    copyStableFieldKeys(prev, next);
    return next;
  }

  /**
   * Ensure the `plugin` field is a choice field and its options cover every slug
   * already present on rows (migrates legacy `type: 'text'` definitions).
   */
  async function reconcilePluginFieldAsChoice(coll, curFields, desired) {
    const desiredPlugin = desired.fields.find((f) => f && f.id === FIELD_PLUGIN);
    if (!desiredPlugin) return { fields: curFields, changed: false };

    const idx = findPluginColumnFieldIndex(curFields);
    const prev = idx >= 0 ? curFields[idx] : null;

    const choices = [];
    const seen = new Set();
    const pushOpt = (opt) => {
      const n = normalizeChoiceOption(opt);
      if (!n || seen.has(n.id)) return;
      seen.add(n.id);
      choices.push(n);
    };

    if (prev && prev.type === 'choice' && Array.isArray(prev.choices)) {
      for (const c of prev.choices) pushOpt(c);
    }

    let records = [];
    try {
      records = await coll.getAllRecords();
    } catch (_) {}

    const plugCol = pluginColumnPropId(coll, FIELD_PLUGIN);
    const slugSet = new Set();
    for (const r of records) {
      const a = rowField(r, plugCol);
      if (a) slugSet.add(a.trim());
      const inf = inferPluginSlugFromPid(rowField(r, 'plugin_id'));
      if (inf) slugSet.add(inf);
    }
    for (const slug of [...slugSet].sort()) {
      if (!slug) continue;
      pushOpt({ id: slug, label: slug, color: colorForSlug(slug), active: true });
    }

    const useClean = !prev || prev.type !== 'choice';
    const nextPluginField = useClean
      ? cleanPluginChoiceField(prev, desiredPlugin, choices)
      : (() => {
          const merged = {
            ...desiredPlugin,
            type: 'choice',
            choices,
            icon: (prev && prev.icon) || desiredPlugin.icon,
            label: (prev && prev.label) || desiredPlugin.label,
            id: (prev && prev.id) || desiredPlugin.id || FIELD_PLUGIN,
          };
          copyStableFieldKeys(prev, merged);
          return merged;
        })();

    let changed = false;
    if (idx < 0) {
      curFields.push(nextPluginField);
      changed = true;
    } else if (JSON.stringify(prev) !== JSON.stringify(nextPluginField)) {
      curFields[idx] = nextPluginField;
      changed = true;
    }

    return { fields: curFields, changed };
  }

  async function registerPluginSlug(data, { slug, label } = {}) {
    const id = (slug || '').trim();
    if (!id || !data) return;
    await ensurePluginSettingsCollection(data);
    const coll = await findColl(data);
    if (!coll || typeof coll.getConfiguration !== 'function' || typeof coll.saveConfiguration !== 'function') return;
    await upgradePluginSettingsSchema(data, coll);
    try {
      const base = coll.getConfiguration() || {};
      const fields = Array.isArray(base.fields) ? [...base.fields] : [];
      const idx = findPluginColumnFieldIndex(fields);
      if (idx < 0) {
        await rewritePluginChoiceCells(coll);
        return;
      }
      const prev = fields[idx];
      if (prev.type !== 'choice') {
        await rewritePluginChoiceCells(coll);
        return;
      }
      const prevChoices = Array.isArray(prev.choices) ? prev.choices : [];
      const normalized = prevChoices.map((c) => normalizeChoiceOption(c)).filter(Boolean);
      const byId = new Map(normalized.map((c) => [c.id, c]));
      const existing = byId.get(id);
      if (existing) {
        if (label && String(existing.label) !== String(label)) {
          byId.set(id, { ...existing, label: String(label) });
        } else {
          await rewritePluginChoiceCells(coll);
          return;
        }
      } else {
        byId.set(id, { id, label: label || id, color: colorForSlug(id), active: true });
      }
      const prevOrder = normalized.map((c) => c.id);
      const out = [];
      const used = new Set();
      for (const pid of prevOrder) {
        if (byId.has(pid) && !used.has(pid)) {
          out.push(byId.get(pid));
          used.add(pid);
        }
      }
      for (const [pid, opt] of byId) {
        if (!used.has(pid)) {
          out.push(opt);
          used.add(pid);
        }
      }
      const next = { ...prev, type: 'choice', choices: out };
      if (JSON.stringify(prev) !== JSON.stringify(next)) {
        fields[idx] = next;
        const ok = await coll.saveConfiguration(withUnlockedManaged({ ...base, fields }));
        if (ok === false) console.warn('[ThymerPluginSettings] registerPluginSlug: saveConfiguration returned false');
      }
    } catch (e) {
      console.error('[ThymerPluginSettings] registerPluginSlug', e);
    }
    await rewritePluginChoiceCells(coll);
  }

  /**
   * Merge missing field definitions into the Plugin Backend collection
   * (e.g. after Thymer auto-created a minimal schema, or older two-field configs).
   */
  async function upgradePluginSettingsSchema(data, collOpt) {
    await ensurePluginSettingsCollection(data);
    const coll = collOpt || (await findColl(data));
    if (!coll || typeof coll.getConfiguration !== 'function' || typeof coll.saveConfiguration !== 'function') return;
    try {
      let base = coll.getConfiguration() || {};
      try {
        if (typeof coll.getExistingCodeAndConfig === 'function') {
          const pack = coll.getExistingCodeAndConfig();
          if (pack && pack.json && typeof pack.json === 'object') {
            base = { ...base, ...pack.json };
          }
        }
      } catch (_) {}
      const desired = cloneShape();
      const curFields = Array.isArray(base.fields) ? base.fields.map((f) => cloneFieldDef(f)) : [];
      const curIds = new Set(curFields.map((f) => (f && f.id ? f.id : null)).filter(Boolean));
      let changed = false;
      for (const f of desired.fields) {
        if (!f || !f.id || curIds.has(f.id)) continue;
        if (f.id === FIELD_PLUGIN && findPluginColumnFieldIndex(curFields) >= 0) continue;
        curFields.push(cloneFieldDef(f));
        curIds.add(f.id);
        changed = true;
      }
      const rec = await reconcilePluginFieldAsChoice(coll, curFields, desired);
      if (rec.changed) changed = true;
      const finalFields = rec.fields;

      const vMerge = mergeViewsArray(base.views, desired.views);
      if (vMerge.changed) changed = true;
      const finalViews = vMerge.views;

      const curPages = [...(base.page_field_ids || [])];
      const wantPages = [...(desired.page_field_ids || [])];
      const mergedPages = [...new Set([...wantPages, ...curPages])];
      if (JSON.stringify(curPages) !== JSON.stringify(mergedPages)) changed = true;
      if ((base.description || '') !== desired.description) changed = true;
      if ((base.item_name || '') !== (desired.item_name || '')) changed = true;
      if (String(base.name || '').trim() !== COL_NAME) changed = true;
      if (changed) {
        const merged = withUnlockedManaged({
          ...base,
          name: COL_NAME,
          description: desired.description,
          fields: finalFields,
          page_field_ids: mergedPages.length ? mergedPages : wantPages,
          item_name: desired.item_name || base.item_name,
          icon: desired.icon || base.icon,
          color: desired.color !== undefined ? desired.color : base.color,
          home: desired.home !== undefined ? desired.home : base.home,
          views: finalViews,
          sidebar_record_sort_field_id: desired.sidebar_record_sort_field_id || base.sidebar_record_sort_field_id,
          sidebar_record_sort_dir: desired.sidebar_record_sort_dir || base.sidebar_record_sort_dir,
        });
        const ok = await coll.saveConfiguration(merged);
        if (ok === false) console.warn('[ThymerPluginSettings] saveConfiguration returned false (schema not applied?)');
        else {
          try {
            const pf = getPluginFieldDef(coll);
            if (pf && pf.type !== 'choice') {
              console.error(
                '[ThymerPluginSettings] saveConfiguration succeeded but "plugin" field is still type',
                pf.type,
                '— check collection General tab or re-import plugins/plugin-settings/Plugin Backend.json.'
              );
            }
          } catch (_) {}
        }
      }
      await rewritePluginChoiceCells(coll);
    } catch (e) {
      console.error('[ThymerPluginSettings] upgrade schema', e);
    }
  }

  /** Re-apply `plugin` via setChoice so rows are not stuck as “(Other)” after text→choice migration. */
  async function rewritePluginChoiceCells(coll) {
    if (!coll || typeof coll.getAllRecords !== 'function') return;
    try {
      const pluginField = getPluginFieldDef(coll);
      if (!pluginField || pluginField.type !== 'choice') return;
    } catch (_) {
      return;
    }
    let records = [];
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return;
    }
    for (const r of records) {
      let slug = inferPluginSlugFromPid(rowField(r, 'plugin_id'));
      if (!slug) slug = rowField(r, pluginColumnPropId(coll, FIELD_PLUGIN));
      if (!slug) continue;
      setRowField(r, FIELD_PLUGIN, slug, coll);
      // Rows written while setRowField wrongly skipped p.set() for plugin_id (setChoice branch).
      const pidNow = rowField(r, 'plugin_id').trim();
      if (!pidNow) {
        const kind = (rowField(r, FIELD_KIND) || '').trim();
        let legacyVault = false;
        if (!kind) {
          try {
            const raw = rowField(r, 'settings_json');
            if (raw && String(raw).includes('"storageMode"')) legacyVault = true;
          } catch (_) {}
        }
        if (kind === KIND_VAULT || legacyVault) {
          setRowField(r, 'plugin_id', slug, coll);
        } else if (kind === 'config') {
          setRowField(r, 'plugin_id', `${slug}:config`, coll);
        } else if (kind === 'log') {
          let ds = '';
          try {
            const raw = rowField(r, 'settings_json');
            if (raw) {
              const j = JSON.parse(raw);
              if (j && j.date) ds = String(j.date).trim();
            }
          } catch (_) {}
          if (!/^\d{4}-\d{2}-\d{2}$/.test(ds) && typeof r.getName === 'function') {
            ds = String(r.getName() || '').trim();
          }
          if (/^\d{4}-\d{2}-\d{2}$/.test(ds)) {
            setRowField(r, 'plugin_id', `${slug}:log:${ds}`, coll);
          }
        }
      }
    }
  }

  function rowField(r, id) {
    if (!r) return '';
    try {
      const p = r.prop?.(id);
      if (p && typeof p.choice === 'function') {
        const c = p.choice();
        if (c != null && String(c).trim() !== '') return String(c).trim();
      }
    } catch (_) {}
    let v = '';
    try {
      v = r.text?.(id);
    } catch (_) {}
    if (v != null && String(v).trim() !== '') return String(v).trim();
    try {
      const p = r.prop?.(id);
      if (p && typeof p.get === 'function') {
        const g = p.get();
        return g == null ? '' : String(g).trim();
      }
      if (p && typeof p.text === 'function') {
        const t = p.text();
        return t == null ? '' : String(t).trim();
      }
    } catch (_) {}
    return '';
  }

  /** Thymer `setChoice` matches option **label** (see YNAB plugins); return label for slug `id`, else slug. */
  function pluginChoiceSetName(coll, slug) {
    const s = String(slug || '').trim();
    if (!s || !coll || typeof coll.getConfiguration !== 'function') return s;
    try {
      const f = getPluginFieldDef(coll);
      if (!f || f.type !== 'choice' || !Array.isArray(f.choices)) return s;
      const opt = f.choices.find((c) => c && String(c.id || '').trim() === s);
      if (opt && opt.label != null && String(opt.label).trim() !== '') return String(opt.label).trim();
    } catch (_) {}
    return s;
  }

  /**
   * @param coll Optional collection — pass when writing `plugin` so setChoice uses the correct option **label**.
   */
  function setRowField(r, id, value, coll = null) {
    if (!r) return;
    const raw = value == null ? '' : String(value);
    const s = raw.trim();
    const propId = pluginColumnPropId(coll, id);
    try {
      const p = r.prop?.(propId);
      if (!p) return;
      // Thymer exposes setChoice on many property types; it returns false for non-choice fields.
      // Only use setChoice for the Plugin **slug** column — otherwise we return early and never p.set().
      const isPluginChoiceCol = id === FIELD_PLUGIN;
      if (isPluginChoiceCol && typeof p.setChoice === 'function') {
        if (!s) {
          if (typeof p.set === 'function') p.set('');
          return;
        }
        const nameTry = coll != null ? pluginChoiceSetName(coll, s) : s;
        if (p.setChoice(nameTry)) return;
        if (nameTry !== s && p.setChoice(s)) return;
        if (typeof p.set === 'function') {
          try {
            p.set(s);
            return;
          } catch (_) {
            /* continue to warn */
          }
        }
        console.warn('[ThymerPluginSettings] setChoice: no option matched field', id, 'slug', s, 'tried', nameTry);
        return;
      }
      if (typeof p.set === 'function') p.set(raw);
    } catch (e) {
      console.warn('[ThymerPluginSettings] setRowField', id, e);
    }
  }

  /** True for the single mirror row per logical plugin (plugin_id === pluginId and kind vault or legacy). */
  function isVaultRow(r, pluginId) {
    const pid = rowField(r, 'plugin_id');
    if (pid !== pluginId) return false;
    const kind = rowField(r, FIELD_KIND);
    if (kind === KIND_VAULT) return true;
    if (!kind) return true;
    return false;
  }

  function findVaultRecord(records, pluginId) {
    if (!records) return null;
    for (const x of records) {
      if (isVaultRow(x, pluginId)) return x;
    }
    return null;
  }

  function applyVaultRowMeta(r, pluginId, coll) {
    setRowField(r, 'plugin_id', pluginId);
    setRowField(r, FIELD_PLUGIN, pluginId, coll);
    setRowField(r, FIELD_KIND, KIND_VAULT);
  }

  function drain() {
    if (busy || !q.length) return;
    busy = true;
    const job = q.shift();
    Promise.resolve(typeof job === 'function' ? job() : job)
      .catch((e) => console.error('[ThymerPluginSettings]', e))
      .finally(() => {
        busy = false;
        if (q.length) setTimeout(drain, 450);
      });
  }

  function enqueue(job) {
    q.push(job);
    drain();
  }

  /** Sidebar / command palette title may be `getName()` or only `getConfiguration().name`. */
  function collectionDisplayName(c) {
    if (!c) return '';
    let s = '';
    try {
      s = String(c.getName?.() || '').trim();
    } catch (_) {}
    if (s) return s;
    try {
      s = String(c.getConfiguration?.()?.name || '').trim();
    } catch (_) {}
    return s;
  }

  /** When Thymer omits names on `getAllCollections()` entries, match our Path B schema. */
  function pathBCollectionScore(c) {
    if (!c) return 0;
    try {
      const conf = c.getConfiguration?.() || {};
      const fields = Array.isArray(conf.fields) ? conf.fields : [];
      const ids = new Set(fields.map((f) => f && f.id).filter(Boolean));
      if (!ids.has('plugin_id') || !ids.has('settings_json')) return 0;
      let s = 2;
      if (ids.has(FIELD_PLUGIN)) s += 2;
      if (ids.has(FIELD_KIND)) s += 1;
      const nm = collectionDisplayName(c).toLowerCase();
      if (nm && (nm.includes('plugin') && (nm.includes('backend') || nm.includes('setting')))) s += 1;
      return s;
    } catch (_) {
      return 0;
    }
  }

  function pickPathBCollectionHeuristic(all) {
    const list = Array.isArray(all) ? all : [];
    const cands = [];
    let bestS = 0;
    for (const c of list) {
      const sc = pathBCollectionScore(c);
      if (sc > bestS) {
        bestS = sc;
        cands.length = 0;
        cands.push(c);
      } else if (sc === bestS && sc >= 2) {
        cands.push(c);
      }
    }
    if (!cands.length) return null;
    const named = cands.find((c) => {
      const n = collectionDisplayName(c);
      return n === COL_NAME || n === COL_NAME_LEGACY;
    });
    return named || cands[0];
  }

  async function findColl(data) {
    try {
      const pick = (all) => {
        const list = Array.isArray(all) ? all : [];
        return (
          list.find((c) => collectionDisplayName(c) === COL_NAME) ||
          list.find((c) => collectionDisplayName(c) === COL_NAME_LEGACY) ||
          null
        );
      };
      const all = await data.getAllCollections();
      return pick(all) || pickPathBCollectionHeuristic(all) || null;
    } catch (_) {
      return null;
    }
  }

  /** Brute list scan — catches a Backend another iframe just created if `findColl` lags. */
  async function hasPluginBackendOnWorkspace(data) {
    let all;
    try {
      all = await data.getAllCollections();
    } catch (_) {
      return false;
    }
    if (!Array.isArray(all) || all.length === 0) return false;
    for (const c of all) {
      const nm = collectionDisplayName(c);
      if (nm === COL_NAME || nm === COL_NAME_LEGACY) return true;
    }
    return !!pickPathBCollectionHeuristic(all);
  }

  const PB_LOCK_NAME = 'thymer-ext-plugin-backend-ensure-v1';
  const DATA_ENSURE_P = '__thymerExtDataPluginBackendEnsureP';

  function dlogPathB(phase, extra) {
    if (!DEBUG_COLLECTIONS) return;
    try {
      const row = { runId: DEBUG_PATHB_ID, phase, t: (typeof performance !== 'undefined' && performance.now) ? +performance.now().toFixed(1) : 0, ...extra };
      console.info('[ThymerExt/PluginBackend]', row);
    } catch (_) {
      void 0;
    }
  }

  function pathBWindowSnapshot() {
    const snap = { runId: DEBUG_PATHB_ID, topReadable: null, hasLocks: null };
    try {
      if (typeof window !== 'undefined' && window.top) {
        void window.top.document;
        snap.topReadable = true;
      }
    } catch (e) {
      snap.topReadable = false;
      try {
        snap.topErr = String((e && e.name) || e) || 'top-doc-threw';
      } catch (_) {
        snap.topErr = 'top-doc-threw';
      }
    }
    const host = getSharedDeduplicationWindow();
    try {
      snap.hasLocks = !!(typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request);
    } catch (_) {
      snap.hasLocks = 'err';
    }
    try {
      snap.locationHref = typeof location !== 'undefined' ? String(location.href) : '';
    } catch (_) {
      snap.locationHref = '';
    }
    try {
      snap.hasSelf = typeof self !== 'undefined' && self === window;
      snap.selfIsTop = typeof window !== 'undefined' && window === window.top;
      snap.hostIsTop = host === (typeof window !== 'undefined' ? window.top : null);
      snap.hostIsSelf = host === (typeof window !== 'undefined' ? window : null);
      snap.hostType = (host && host.constructor && host.constructor.name) || '';
    } catch (_) {
      void 0;
    }
    try {
      snap.gHasPbP = host && host[PB_ENSURE_GLOBAL_P] != null;
      snap.gHasCreateQ = host && host[SERIAL_DATA_CREATE_P] != null;
    } catch (_) {
      void 0;
    }
    return snap;
  }

  function queueDataCreateOnSharedWindow(factory) {
    const host = getSharedDeduplicationWindow();
    if (DEBUG_COLLECTIONS) {
      dlogPathB('queueDataCreate_enter', { ...pathBWindowSnapshot() });
    }
    try {
      if (!host[SERIAL_DATA_CREATE_P] || typeof host[SERIAL_DATA_CREATE_P].then !== 'function') {
        host[SERIAL_DATA_CREATE_P] = Promise.resolve();
      }
      const out = (host[SERIAL_DATA_CREATE_P] = host[SERIAL_DATA_CREATE_P].catch(() => {}).then(factory));
      if (DEBUG_COLLECTIONS) dlogPathB('queueDataCreate_chained', { gHasCreateQ: !!host[SERIAL_DATA_CREATE_P] });
      return out;
    } catch (e) {
      if (DEBUG_COLLECTIONS) dlogPathB('queueDataCreate_fallback', { err: String((e && e.message) || e) });
      return factory();
    }
  }

  async function runPluginBackendEnsureBody(data) {
    if (DEBUG_COLLECTIONS) {
      dlogPathB('ensureBody_start', { pathB: pathBWindowSnapshot() });
      try {
        if (data && data.getAllCollections) {
          const a = await data.getAllCollections();
          const collNames = (Array.isArray(a) ? a : []).map((c) => {
            try { return String(collectionDisplayName(c) || '').trim() || '(no-name)'; } catch (__) { return '(err)'; }
          });
          dlogPathB('ensureBody_collections', { count: (collNames && collNames.length) || 0, names: (collNames || []).slice(0, 40) });
          if (data && data.getAllCollections) touchGetAllSanityFromCount((collNames && collNames.length) || 0);
        }
      } catch (e) {
        dlogPathB('ensureBody_getAll_failed', { err: String((e && e.message) || e) });
      }
    }
    try {
      let existing = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        existing = await findColl(data);
        if (existing) return;
        if (await hasPluginBackendOnWorkspace(data)) return;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 50 + attempt * 50));
      }
      existing = await findColl(data);
      if (existing) return;
      if (await hasPluginBackendOnWorkspace(data)) return;
      await new Promise((r) => setTimeout(r, 120));
      if (await findColl(data)) return;
      if (await hasPluginBackendOnWorkspace(data)) return;
      let preCreateLen = 0;
      try {
        if (data && data.getAllCollections) {
          const all0 = await data.getAllCollections();
          preCreateLen = Array.isArray(all0) ? all0.length : 0;
          if (preCreateLen > 0) touchGetAllSanityFromCount(preCreateLen);
        }
        if (preCreateLen === 0) {
          await new Promise((r) => setTimeout(r, 150));
          if (data && data.getAllCollections) {
            const all1 = await data.getAllCollections();
            preCreateLen = Array.isArray(all1) ? all1.length : 0;
            if (preCreateLen > 0) touchGetAllSanityFromCount(preCreateLen);
          }
        }
        if (preCreateLen > 0) {
          if (await findColl(data)) return;
          if (await hasPluginBackendOnWorkspace(data)) return;
        }
        if (isSuspiciousEmptyAfterRecentNonEmptyList(preCreateLen) && preCreateLen === 0) {
          if (DEBUG_COLLECTIONS) {
            try {
              const h = getSharedDeduplicationWindow();
              dlogPathB('refuse_create_flaky_getall_empty', { pathB: pathBWindowSnapshot(), s: h[GETALL_COLLECTIONS_SANITY] || null });
            } catch (_) {
              dlogPathB('refuse_create_flaky_getall_empty', { pathB: pathBWindowSnapshot() });
            }
          }
          return;
        }
      } catch (_) {
        void 0;
      }
      if (DEBUG_COLLECTIONS) dlogPathB('ensureBody_about_to_create', { pathB: pathBWindowSnapshot() });
      const coll = await queueDataCreateOnSharedWindow(() => data.createCollection());
      if (!coll || typeof coll.getConfiguration !== 'function' || typeof coll.saveConfiguration !== 'function') {
        return;
      }
      const conf = cloneShape();
      const base = coll.getConfiguration();
      if (base && typeof base.ver === 'number') conf.ver = base.ver;
      const ok = await coll.saveConfiguration(conf);
      if (ok === false) return;
      await new Promise((r) => setTimeout(r, 250));
    } catch (e) {
      console.error('[ThymerPluginSettings] ensure collection', e);
    }
  }

  function runPluginBackendEnsureWithLocksOrChain(data) {
    try {
      if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
        if (DEBUG_COLLECTIONS) dlogPathB('ensure_route', { via: 'locks', lockName: PB_LOCK_NAME, pathB: pathBWindowSnapshot() });
        return navigator.locks.request(PB_LOCK_NAME, () => runPluginBackendEnsureBody(data));
      }
    } catch (e) {
      if (DEBUG_COLLECTIONS) dlogPathB('ensure_locks_threw', { err: String((e && e.message) || e) });
    }
    if (DEBUG_COLLECTIONS) dlogPathB('ensure_route', { via: 'hierarchyChain', pathB: pathBWindowSnapshot() });
    return chainPluginBackendEnsure(data, () => runPluginBackendEnsureBody(data));
  }

  function ensurePluginSettingsCollection(data) {
    if (DEBUG_COLLECTIONS) {
      let dHint = 'no-data';
      try {
        dHint = data
          ? `ctor=${(data && data.constructor && data.constructor.name) || '?'},eqPrev=${(data && data === g.__th_lastDataPb) || false},keys=${
            Object.keys(data).filter((k) => k && (k.includes('thymer') || k.includes('__'))).length
          }`
          : 'null';
        g.__th_lastDataPb = data;
      } catch (_) {
        dHint = 'err';
      }
      dlogPathB('ensurePluginSettingsCollection', { dataHint: dHint, dataExpand: (() => { try { if (!data) return { ok: false }; return { hasDataEnsure: !!data[DATA_ENSURE_P] }; } catch (_) { return { ok: 'throw' }; } })(), pathB: pathBWindowSnapshot() });
    }
    if (!data || typeof data.getAllCollections !== 'function' || typeof data.createCollection !== 'function') {
      return Promise.resolve();
    }
    try {
      if (!data[DATA_ENSURE_P] || typeof data[DATA_ENSURE_P].then !== 'function') {
        data[DATA_ENSURE_P] = Promise.resolve();
      }
      if (DEBUG_COLLECTIONS) dlogPathB('data_ensure_p_chained', { hasPriorTail: true });
      const next = data[DATA_ENSURE_P]
        .catch(() => {})
        .then(() => runPluginBackendEnsureWithLocksOrChain(data));
      data[DATA_ENSURE_P] = next;
      return next;
    } catch (e) {
      if (DEBUG_COLLECTIONS) dlogPathB('data_ensure_p_throw', { err: String((e && e.message) || e) });
      return runPluginBackendEnsureWithLocksOrChain(data);
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
    const r = findVaultRecord(records, pluginId);
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
    await upgradePluginSettingsSchema(data, coll);
    const json = JSON.stringify(doc);
    let records;
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return;
    }
    let r = findVaultRecord(records, pluginId);
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
            r = again.find((x) => x.guid === guid) || findVaultRecord(again, pluginId);
            if (r) break;
          } catch (_) {}
        }
      }
    }
    if (!r) return;
    applyVaultRowMeta(r, pluginId, coll);
    try {
      const pj = r.prop?.('settings_json');
      if (pj && typeof pj.set === 'function') pj.set(json);
    } catch (_) {}
  }

  async function listRows(data, { pluginSlug, recordKind } = {}) {
    const slug = (pluginSlug || '').trim();
    if (!slug) return [];
    const coll = await findColl(data);
    if (!coll) return [];
    let records;
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return [];
    }
    const plugCol = pluginColumnPropId(coll, FIELD_PLUGIN);
    return records.filter((r) => {
      const pid = rowField(r, 'plugin_id');
      let rowSlug = rowField(r, plugCol);
      if (!rowSlug) rowSlug = inferPluginSlugFromPid(pid);
      if (rowSlug !== slug) return false;
      if (recordKind != null && String(recordKind) !== '') {
        const rk = rowField(r, FIELD_KIND) || inferRecordKindFromPid(pid, slug);
        return rk === String(recordKind);
      }
      return true;
    });
  }

  async function createDataRow(data, { pluginSlug, recordKind, rowPluginId, recordTitle, settingsDoc } = {}) {
    const ps = (pluginSlug || '').trim();
    const rid = (rowPluginId || '').trim();
    const kind = (recordKind || '').trim();
    if (!ps || !rid || !kind) {
      console.warn('[ThymerPluginSettings] createDataRow: pluginSlug, recordKind, and rowPluginId are required');
      return null;
    }
    if (rid === ps && kind !== KIND_VAULT) {
      console.warn('[ThymerPluginSettings] createDataRow: rowPluginId must differ from plugin slug unless record_kind is vault');
    }
    await ensurePluginSettingsCollection(data);
    const coll = await findColl(data);
    if (!coll) return null;
    await upgradePluginSettingsSchema(data, coll);
    const title = (recordTitle || rid).trim() || rid;
    let guid = null;
    try {
      guid = coll.createRecord?.(title);
    } catch (e) {
      console.error('[ThymerPluginSettings] createDataRow createRecord', e);
      return null;
    }
    if (!guid) return null;
    let r = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, i < 8 ? 100 : 200));
      try {
        const again = await coll.getAllRecords();
        r = again.find((x) => x.guid === guid) || again.find((x) => rowField(x, 'plugin_id') === rid);
        if (r) break;
      } catch (_) {}
    }
    if (!r) return null;
    setRowField(r, 'plugin_id', rid);
    setRowField(r, FIELD_PLUGIN, ps, coll);
    setRowField(r, FIELD_KIND, kind);
    const json =
      settingsDoc !== undefined && settingsDoc !== null
        ? typeof settingsDoc === 'string'
          ? settingsDoc
          : JSON.stringify(settingsDoc)
        : '{}';
    try {
      const pj = r.prop?.('settings_json');
      if (pj && typeof pj.set === 'function') pj.set(json);
    } catch (_) {}
    return r;
  }

  function showFirstRunDialog(ui, label, preferred, onPick) {
    const id = 'thymerext-ps-first-' + Math.random().toString(36).slice(2);
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
    const bSyn = mk(
      'Sync across devices',
      'Store in the workspace “' + COL_NAME + '” collection (same account on any browser).',
      preferred === 'synced'
    );
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

  g.ThymerPluginSettings = {
    COL_NAME,
    COL_NAME_LEGACY,
    FIELD_PLUGIN,
    FIELD_RECORD_KIND: FIELD_KIND,
    RECORD_KIND_VAULT: KIND_VAULT,
    enqueue,
    rowField,
    findVaultRecord,
    listRows,
    createDataRow,
    upgradeCollectionSchema: (data) => upgradePluginSettingsSchema(data),
    registerPluginSlug,

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
        await new Promise((r) => {
          requestAnimationFrame(() => requestAnimationFrame(() => r()));
        });
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

      plugin._pluginSettingsSyncMode = mode === 'synced' ? 'synced' : 'local';
      plugin._pluginSettingsPluginId = pluginId;
      const keys = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;

      if (plugin._pluginSettingsSyncMode === 'synced' && remote && remote.payload && typeof remote.payload === 'object') {
        for (const k of keys) {
          const v = remote.payload[k];
          if (typeof v === 'string') {
            try {
              localStorage.setItem(k, v);
            } catch (_) {}
          }
        }
      }

      if (plugin._pluginSettingsSyncMode === 'synced') {
        try {
          await g.ThymerPluginSettings.flushNow(data, pluginId, keys);
        } catch (_) {}
      }
    },

    scheduleFlush(plugin, mirrorKeys) {
      if (plugin._pluginSettingsSyncMode !== 'synced') return;
      const keys = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      if (plugin._pluginSettingsFlushTimer) clearTimeout(plugin._pluginSettingsFlushTimer);
      plugin._pluginSettingsFlushTimer = setTimeout(() => {
        plugin._pluginSettingsFlushTimer = null;
        const pdata = plugin.data;
        const pid = plugin._pluginSettingsPluginId;
        if (!pid || !pdata) return;
        g.ThymerPluginSettings.flushNow(pdata, pid, keys).catch((e) => console.error('[ThymerPluginSettings] flush', e));
      }, 500);
    },

    async flushNow(data, pluginId, mirrorKeys) {
      await ensurePluginSettingsCollection(data);
      await upgradePluginSettingsSchema(data);
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
      const cur = plugin._pluginSettingsSyncMode === 'synced' ? 'synced' : 'local';
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
        b2.textContent = 'Sync across devices';
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
      plugin._pluginSettingsSyncMode = pick === 'synced' ? 'synced' : 'local';
      const keyList = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      if (pick === 'synced') await g.ThymerPluginSettings.flushNow(data, pluginId, keyList);
      ui.addToaster?.({
        title: label,
        message: pick === 'synced' ? 'Settings will sync across devices.' : 'Settings stay on this device only.',
        dismissible: true,
        autoDestroyTime: 3500,
      });
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
// @generated END thymer-plugin-settings

/*
  SIDEBAR  : Prompt+ (ti-message-plus)
  STATUS   : same icon — one click opens the flow
  CMD+K    : "Prompt+" | "Prompt+: Configure"

  Journal reference insertion is intentionally omitted — Today's Notes
  footer surfaces records automatically based on their When date.

  CONFIG stored in localStorage "qn_config_v2"
  TEMPLATES stored in a collection named "Quick Note Templates"
*/

const QN_STORAGE_KEY    = 'qn_config_v2';
const QN_TEMPLATES_COLL = 'Quick Note Templates';
/** Tabler icon + display name (collection "Quick Note Templates" unchanged for existing workspaces). */
const QN_PLUGIN_ICON = 'ti-message-plus';
const QN_PLUGIN_NAME = 'Prompt+';

class Plugin extends AppPlugin {

  async onLoad() {
    await (globalThis.ThymerPluginSettings?.init?.({
      plugin: this,
      pluginId: 'quick-notes',
      modeKey: 'thymerext_ps_mode_quick_notes',
      mirrorKeys: () => [QN_STORAGE_KEY],
      label: QN_PLUGIN_NAME,
      data: this.data,
      ui: this.ui,
    }) ?? (console.warn(`[${QN_PLUGIN_NAME}] ThymerPluginSettings runtime missing (redeploy full plugin .js from repo).`), Promise.resolve()));
    this._eventHandlerIds = [];
    this._running         = false; // guard against double-trigger
    this._config          = this._loadConfig();

    this.ui.registerCustomPanelType('qn-configure', (panel) => {
      this._mountConfigPanel(panel);
    });

    this.ui.addSidebarItem({
      icon: QN_PLUGIN_ICON, label: QN_PLUGIN_NAME, tooltip: 'Create a timestamped note',
      onClick: () => this.run(),
    });
    this._qnStatusItem = this.ui.addStatusBarItem?.({
      icon: QN_PLUGIN_ICON,
      tooltip: `${QN_PLUGIN_NAME} — create a timestamped note`,
      onClick: () => this.run(),
    }) ?? null;
    this.ui.addCommandPaletteCommand({
      label: QN_PLUGIN_NAME, icon: QN_PLUGIN_ICON, onSelected: () => this.run(),
    });
    this.ui.addCommandPaletteCommand({
      label: `${QN_PLUGIN_NAME}: Configure`, icon: 'ti-settings',
      onSelected: () => this.openConfigPanel(),
    });
    this.ui.addCommandPaletteCommand({
      label: `${QN_PLUGIN_NAME}: Insert Template Here`, icon: 'ti-template',
      onSelected: () => this._insertTemplateAtCursor(),
    });
    this.ui.addCommandPaletteCommand({
      label: `${QN_PLUGIN_NAME}: Storage location…`,
      icon: 'ti-database',
      onSelected: () => {
        globalThis.ThymerPluginSettings?.openStorageDialog?.({
          plugin: this,
          pluginId: 'quick-notes',
          modeKey: 'thymerext_ps_mode_quick_notes',
          mirrorKeys: () => [QN_STORAGE_KEY],
          label: QN_PLUGIN_NAME,
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
    try { this._qnStatusItem?.remove?.(); } catch (_) {}
    this._qnStatusItem = null;
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
    globalThis.ThymerPluginSettings?.scheduleFlush?.(this, () => [QN_STORAGE_KEY]);
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
    panel.setTitle(`${QN_PLUGIN_NAME} — Configure`);

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
        this.ui.addToaster({ title: 'Saved', message: `${QN_PLUGIN_NAME} settings saved.`, dismissible: true, autoDestroyTime: 3000 });
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
        this.ui.addToaster({ title: 'No collections configured', message: `Use "${QN_PLUGIN_NAME}: Configure" in the command palette.`, dismissible: true, autoDestroyTime: 5000 });
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
      console.error(`[${QN_PLUGIN_NAME}]`, e);
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
      console.error(`[${QN_PLUGIN_NAME}] Insert template error:`, e);
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
      console.error(`[${QN_PLUGIN_NAME}] Template insert error:`, e);
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
      console.error(`[${QN_PLUGIN_NAME}] Template apply error:`, e);
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
      const { left, top, width } = this._qnPromptShellPosition(panel, 380, 12);
      const box = document.createElement('div');
      box.style.cssText = this._qnFrostedPromptShellStyle(left, top, width)
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
      const { left, top, width } = this._qnPromptShellPosition(panel, 360, 12);
      const box = document.createElement('div');
      box.style.cssText = this._qnFrostedPromptShellStyle(left, top, width)
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

  _qnPromptShellPosition(panel, preferredWidth = 350, margin = 12) {
    const maxAllowedWidth = Math.max(240, window.innerWidth - (margin * 2));
    const width = Math.min(preferredWidth, maxAllowedWidth);
    let left = Math.round(window.innerWidth / 2) - Math.round(width / 2);
    let top  = Math.round(window.innerHeight / 3);
    if (panel) {
      const el = panel.getElement();
      if (el) {
        const r = el.getBoundingClientRect();
        left = Math.round(r.left + r.width / 2) - Math.round(width / 2);
        top  = Math.round(r.top + 80);
      }
    }
    const clampedLeft = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    const clampedTop = Math.max(margin, Math.min(top, window.innerHeight - 140));
    return { left: clampedLeft, top: clampedTop, width };
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
      + `padding:16px;z-index:99999;display:flex;flex-direction:column;gap:10px;max-width:calc(100vw - 24px);`;
  }

  _promptDate(fieldName, fieldConf, fieldMeta, conf) {
    return new Promise((resolve) => {
      const { includeTime: initialInclude, locked } = this._datePromptTimeMode(fieldConf, fieldMeta, conf);
      let includeTime = initialInclude;

      const panel = this.ui.getActivePanel();
      const { left, top, width } = this._qnPromptShellPosition(panel, 350, 12);
      const box = document.createElement('div');
      box.style.cssText = this._qnFrostedPromptShellStyle(left, top, width);
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
      const { left, top, width } = this._qnPromptShellPosition(panel, 350, 12);
      const box = document.createElement('div');
      box.style.cssText = this._qnFrostedPromptShellStyle(left, top, width);
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