// ==Plugin==
// name: Quick Note
// description: Create a timestamped note in any configured collection
// icon: ti-bolt
// ==/Plugin==

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

  onLoad() {
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
      cfg.appendChild(this._miniRow('Type', this._miniSelect(['text','reference','choice'], fconf.type||'text', v => { item.fieldConfig[fname]=item.fieldConfig[fname]||{}; item.fieldConfig[fname].type=v; rerender(); })));
      if ((fconf.type||'text')==='reference') cfg.appendChild(this._miniRow('Source collection', this._miniInput(fconf.sourceCollection||'People', v => { item.fieldConfig[fname]=item.fieldConfig[fname]||{}; item.fieldConfig[fname].sourceCollection=v; })));
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
    sec.appendChild(this._cfgLabel('Date Field', 'Auto-filled with today\'s date on creation'));

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

      // Prompt each field
      const fieldValues = {};
      for (const fieldName of promptedFields) {
        const value = await this._promptField(fieldName, conf.fieldConfig?.[fieldName] || {}, allCollections);
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
        // Auto-fill date field
        const autoFillDate = conf.autoFillDate !== undefined ? conf.autoFillDate : 'When';
        if (autoFillDate) {
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
            const prop   = record.prop(fname);
            if (!prop) continue;
            const setVal = val.guid !== undefined ? val.guid : val.displayValue;
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

  _pickFromDropdown(options, placeholder) {
    return new Promise((resolve) => {
      const panel = this.ui.getActivePanel();
      let left = Math.round(window.innerWidth / 2) - 175;
      let top  = Math.round(window.innerHeight / 3);
      if (panel) {
        const el = panel.getElement();
        if (el) { const r=el.getBoundingClientRect(); left=Math.round(r.left+r.width/2)-175; top=Math.round(r.top+80); }
      }
      const anchor = document.createElement('div');
      anchor.style.cssText = `position:fixed;left:${left}px;top:${top}px;width:350px;height:0;pointer-events:none;`;
      document.body.appendChild(anchor);
      let resolved = false;
      const done = (val) => { if (resolved) return; resolved=true; setTimeout(() => { if (anchor.parentNode) anchor.remove(); }, 300); resolve(val); };
      this.ui.createDropdown({
        attachedTo: anchor,
        options: options.map(opt => ({ label: opt.label, icon: 'ti-chevron-right', onSelected: () => done(opt.value) })),
        inputPlaceholder: placeholder || 'Search…',
        width: 350,
      });
      const check = setInterval(() => { if (!document.body.contains(anchor)) { clearInterval(check); done(null); } }, 200);
      setTimeout(() => { clearInterval(check); done(null); }, 30000);
    });
  }

  async _promptField(fieldName, fieldConf, allCollections) {
    const type = fieldConf.type || 'text';
    if (type === 'reference') {
      const sourceColl = allCollections.find(c => c.getName() === (fieldConf.sourceCollection || 'People'));
      const records    = sourceColl ? await sourceColl.getAllRecords() : [];
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

  _promptText(fieldName) {
    return new Promise((resolve) => {
      const panel = this.ui.getActivePanel();
      let left = Math.round(window.innerWidth/2)-175, top = Math.round(window.innerHeight/3);
      if (panel) { const el=panel.getElement(); if (el) { const r=el.getBoundingClientRect(); left=Math.round(r.left+r.width/2)-175; top=Math.round(r.top+80); } }
      const box = document.createElement('div');
      box.style.cssText=`position:fixed;left:${left}px;top:${top}px;width:350px;background:var(--cmdpal-bg-color,var(--panel-bg-color,#1d1915));border:1px solid var(--border-default,#3f3f46);border-radius:10px;box-shadow:var(--cmdpal-box-shadow,0 8px 32px rgba(0,0,0,0.5));padding:16px;z-index:99999;display:flex;flex-direction:column;gap:10px;`;
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

  _tinyBtn(text, disabled, onClick) {
    const btn=document.createElement('button'); btn.textContent=text; btn.disabled=disabled;
    btn.style.cssText=`background:none;border:none;cursor:${disabled?'default':'pointer'};font-size:11px;padding:2px 4px;opacity:${disabled?'0.3':'1'};color:inherit;`;
    if (!disabled) btn.addEventListener('click',onClick); return btn;
  }
}