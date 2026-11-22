/*
 * Settings: the options (saved on the TV), the Settings screen, and the category editor.
 * Screens get what they need from app.js through a small `ctx` object.
 */
(function (global) {
    'use strict';

    var Store = global.Store;

    /* ------------------------------------------------------------------ */
    /* Options                                                             */
    /* ------------------------------------------------------------------ */

    var DEFS = [
        {
            key: 'buffer', group: 'Playback', label: 'Buffering', def: 'balanced',
            options: [['fast', 'Fast start'], ['balanced', 'Balanced'], ['stable', 'Fewer stalls']],
            help: {
                fast: 'Buffers 2 seconds before playing. Channels start quickly; best on a fast, steady connection.',
                balanced: 'Buffers 4 seconds before playing. A good mix of quick starts and smooth playback.',
                stable: 'Buffers 8 seconds before playing. Slower to start, but rides out Wi-Fi or provider hiccups.'
            }
        },
        {
            key: 'format', group: 'Playback', label: 'Stream format', def: 'auto',
            options: [['auto', 'Automatic'], ['m3u8', 'HLS'], ['ts', 'MPEG-TS']],
            help: {
                auto: 'Uses HLS when your provider offers it (works best on Samsung TVs), otherwise MPEG-TS.',
                m3u8: 'Always request HLS (.m3u8) streams.',
                ts: 'Always request MPEG-TS (.ts) streams. Can start faster with some providers, but redirected streams may fail.'
            }
        },
        {
            key: 'retries', group: 'Playback', label: 'Retry a channel', def: 2,
            options: [[0, 'Off'], [1, 'Once'], [2, 'Twice'], [3, '3 times']],
            help: 'If a channel doesn\'t connect, try it again this many times before showing an error.'
        },
        {
            key: 'startup', group: 'Startup & display', label: 'When FrameCast opens', def: 'list',
            options: [['list', 'Show channel list'], ['last', 'Play last channel']],
            help: 'What to show after signing in when the app starts.'
        },
        {
            key: 'clock', group: 'Startup & display', label: 'Clock', def: '12',
            options: [['12', '12-hour'], ['24', '24-hour']],
            help: 'Time format for the clock, guide and info bar.'
        },
        {
            key: 'osd', group: 'Startup & display', label: 'Info bar stays for', def: 5,
            options: [[3, '3 seconds'], [5, '5 seconds'], [8, '8 seconds'], [0, 'Until dismissed']],
            help: 'How long the channel info bar stays on screen after changing channel. With "Until dismissed", press BACK or OK to hide it.'
        }
    ];

    var BUFFERS = { fast: [2, 3], balanced: [4, 6], stable: [8, 10] };

    var values = Store.read('settings', {});
    var listeners = [];

    function def(key) {
        for (var i = 0; i < DEFS.length; i++) if (DEFS[i].key === key) return DEFS[i];
        return null;
    }

    function get(key) {
        var d = def(key);
        var v = values[key];
        if (!d) return v;
        for (var i = 0; i < d.options.length; i++) if (d.options[i][0] === v) return v;
        return d.def;
    }

    function set(key, v) {
        values[key] = v;
        Store.write('settings', values);
        listeners.forEach(function (fn) { fn(key, v); });
    }

    function valueLabel(key) {
        var d = def(key), v = get(key);
        for (var i = 0; i < d.options.length; i++) if (d.options[i][0] === v) return d.options[i][1];
        return String(v);
    }

    function step(key, delta) {
        var d = def(key), v = get(key), idx = 0;
        for (var i = 0; i < d.options.length; i++) if (d.options[i][0] === v) idx = i;
        idx = (idx + delta + d.options.length) % d.options.length;
        set(key, d.options[idx][0]);
    }

    function helpFor(key) {
        var d = def(key);
        return typeof d.help === 'string' ? d.help : (d.help[get(key)] || '');
    }

    var Settings = {
        defs: DEFS,
        get: get,
        set: set,
        step: step,
        valueLabel: valueLabel,
        helpFor: helpFor,
        buffer: function () { var b = BUFFERS[get('buffer')]; return { play: b[0], resume: b[1] }; },
        onChange: function (fn) { listeners.push(fn); }
    };

    /* ------------------------------------------------------------------ */
    /* Settings screen                                                     */
    /* ------------------------------------------------------------------ */

    function SettingsScreen(ctx) {
        this.ctx = ctx;
        this.sel = 0;
        this.rows = [];
        this.list = document.getElementById('settings-list');
        this.help = document.getElementById('settings-help');
    }

    SettingsScreen.prototype.buildRows = function () {
        var ctx = this.ctx, rows = [], lastGroup = null;
        DEFS.forEach(function (d) {
            if (d.group !== lastGroup) { rows.push({ kind: 'header', label: d.group }); lastGroup = d.group; }
            rows.push({ kind: 'choice', key: d.key, label: d.label });
        });
        rows.push({ kind: 'header', label: 'Channels' });
        rows.push({
            kind: 'action', label: 'Categories', value: 'Reorder & hide ›',
            help: 'Change the order of categories in the side menu, or hide ones you never use.',
            run: function () { ctx.openCategoryEditor(); }
        });
        rows.push({
            kind: 'action', label: 'Refresh channel list', value: 'Reload ›',
            help: 'Download the channel list again from your provider, for example after they add channels.',
            run: function () { ctx.refresh(); }
        });
        rows.push({ kind: 'header', label: 'Account' });
        rows.push({
            kind: 'action', label: ctx.accountLabel(), value: 'Sign out ›',
            help: 'Sign out and forget the saved server and login on this TV. Favorites are kept.',
            confirm: 'Press OK again to sign out',
            run: function () { ctx.signOut(); }
        });
        rows.push({ kind: 'header', label: 'About' });
        rows.push({ kind: 'info', label: 'FrameCast', value: 'Version ' + ctx.version, help: 'github.com/jzkdroid/framecast-tizen' });
        this.rows = rows;
    };

    SettingsScreen.prototype.open = function () {
        this.buildRows();
        this.armed = null;
        if (!this.rows[this.sel] || this.rows[this.sel].kind === 'header') this.sel = this.nextFocusable(-1, 1);
        this.render();
    };

    SettingsScreen.prototype.nextFocusable = function (from, dir) {
        for (var i = from + dir; i >= 0 && i < this.rows.length; i += dir) {
            if (this.rows[i].kind !== 'header') return i;
        }
        return from;
    };

    SettingsScreen.prototype.render = function () {
        var esc = this.ctx.esc, sel = this.sel, armed = this.armed;
        this.list.innerHTML = this.rows.map(function (r, i) {
            if (r.kind === 'header') return '<li class="set-header">' + esc(r.label) + '</li>';
            var value = r.kind === 'choice' ? Settings.valueLabel(r.key) : r.value;
            if (armed === i && r.confirm) value = r.confirm;
            var arrows = r.kind === 'choice' ? '<span class="set-arrow">‹</span>' : '';
            var arrowsR = r.kind === 'choice' ? '<span class="set-arrow">›</span>' : '';
            return '<li class="set-row' + (i === sel ? ' selected' : '') + (r.kind === 'info' ? ' info' : '') + '">' +
                '<span class="set-label">' + esc(r.label) + '</span>' +
                '<span class="set-value">' + arrows + esc(value) + arrowsR + '</span></li>';
        }).join('');
        var row = this.rows[sel];
        this.help.textContent = !row ? '' : row.kind === 'choice' ? Settings.helpFor(row.key) : (row.help || '');
        // Keep the selected row in view, with its section heading when there's one just above.
        // (The list is position:relative, so offsetTop is measured from the top of the list.)
        var el = this.list.children[sel];
        if (el) {
            var prev = this.list.children[sel - 1];
            var top = prev && prev.className === 'set-header' ? prev.offsetTop : el.offsetTop;
            var bottom = el.offsetTop + el.offsetHeight;
            if (top < this.list.scrollTop) this.list.scrollTop = Math.max(0, top - 10);
            else if (bottom > this.list.scrollTop + this.list.clientHeight) this.list.scrollTop = bottom - this.list.clientHeight + 20;
        }
    };

    SettingsScreen.prototype.onKey = function (a) {
        var row = this.rows[this.sel];
        switch (a) {
            case 'up': case 'down': {
                var next = this.nextFocusable(this.sel, a === 'up' ? -1 : 1);
                if (next !== this.sel) { this.sel = next; this.armed = null; this.render(); }
                return true;
            }
            case 'left': case 'right':
                if (row && row.kind === 'choice') { Settings.step(row.key, a === 'left' ? -1 : 1); this.render(); }
                return true;
            case 'ok':
                if (!row) return true;
                if (row.kind === 'choice') { Settings.step(row.key, 1); this.render(); }
                else if (row.kind === 'action') {
                    if (row.confirm && this.armed !== this.sel) { this.armed = this.sel; this.render(); return true; }
                    this.armed = null;
                    row.run();
                }
                return true;
            case 'back':
                this.ctx.close();
                return true;
        }
        return false;
    };

    /* ------------------------------------------------------------------ */
    /* Category editor                                                     */
    /* ------------------------------------------------------------------ */

    /*
     * ctx: { esc, categories() -> [{id,name}] in current order (incl. hidden),
     *        hidden() -> {id:true}, count(cat), save(orderIds, hiddenMap), close() }
     */
    function CategoryEditor(ctx) {
        this.ctx = ctx;
        this.list = document.getElementById('cated-list');
        this.help = document.getElementById('cated-help');
        this.sel = 0;
        this.top = 0;
        this.moving = false;
        this.rowHeight = 64;
    }

    CategoryEditor.prototype.open = function () {
        this.items = this.ctx.categories().slice();
        this.hidden = JSON.parse(JSON.stringify(this.ctx.hidden() || {}));
        this.sel = 0;
        this.top = 0;
        this.moving = false;
        this.render();
    };

    CategoryEditor.prototype.visibleCount = function () {
        var h = this.list.clientHeight;
        if (h > 0) this.lastCount = Math.max(1, Math.floor(h / this.rowHeight));
        return this.lastCount || 12;
    };

    CategoryEditor.prototype.rowCount = function () { return this.items.length + 1; };   // + "Reset" row

    CategoryEditor.prototype.render = function () {
        var esc = this.ctx.esc, n = this.visibleCount(), self = this;
        if (this.sel < this.top) this.top = this.sel;
        if (this.sel >= this.top + n) this.top = this.sel - n + 1;
        this.top = Math.max(0, Math.min(this.top, Math.max(0, this.rowCount() - n)));
        var html = '';
        for (var i = this.top; i < Math.min(this.rowCount(), this.top + n); i++) {
            var selected = i === this.sel;
            if (i === 0) {
                html += '<li class="cated-row reset' + (selected ? ' selected' : '') + '"><span class="label">↺ Reset to provider order, show all</span></li>';
                continue;
            }
            var c = this.items[i - 1];
            var off = !!this.hidden[c.id];
            html += '<li class="cated-row' + (selected ? ' selected' : '') + (selected && this.moving ? ' moving' : '') + (off ? ' off' : '') + '">' +
                '<span class="cated-pos">' + i + '</span>' +
                '<span class="label">' + (selected && this.moving ? '⇅ ' : '') + esc(c.name) + '</span>' +
                '<span class="count">' + esc(self.ctx.count(c)) + '</span>' +
                '<span class="cated-toggle">' + (off ? 'Hidden' : 'Shown') + '</span></li>';
        }
        this.list.innerHTML = html;
        this.help.textContent = this.moving
            ? 'Moving: ▲▼ to place it, OK to drop.'
            : this.sel === 0 ? 'OK: put categories back in the provider\'s order and show all of them.'
                : 'OK: pick up and move · ◀ ▶: show or hide · BACK: done';
    };

    CategoryEditor.prototype.persist = function () {
        this.ctx.save(this.items.map(function (c) { return c.id; }), this.hidden);
    };

    CategoryEditor.prototype.onKey = function (a) {
        var count = this.rowCount();
        switch (a) {
            case 'up': case 'down': case 'chup': case 'chdown': {
                var delta = a === 'up' ? -1 : a === 'down' ? 1 : (a === 'chup' ? -this.visibleCount() : this.visibleCount());
                if (this.moving) {
                    var from = this.sel - 1, to = Math.max(0, Math.min(this.items.length - 1, from + delta));
                    if (to !== from) {
                        var item = this.items.splice(from, 1)[0];
                        this.items.splice(to, 0, item);
                        this.sel = to + 1;
                    }
                } else {
                    this.sel = Math.max(0, Math.min(count - 1, this.sel + delta));
                }
                this.render();
                return true;
            }
            case 'ok':
                if (this.sel === 0) {
                    this.items = this.ctx.providerOrder();
                    this.hidden = {};
                    this.persist();
                    this.ctx.toast('Categories reset');
                } else {
                    this.moving = !this.moving;
                    if (!this.moving) this.persist();
                }
                this.render();
                return true;
            case 'left': case 'right':
                if (this.sel > 0 && !this.moving) {
                    var id = this.items[this.sel - 1].id;
                    if (this.hidden[id]) delete this.hidden[id]; else this.hidden[id] = true;
                    this.persist();
                    this.render();
                }
                return true;
            case 'back':
                if (this.moving) { this.moving = false; this.persist(); this.render(); return true; }
                this.ctx.close();
                return true;
        }
        return false;
    };

    global.Settings = Settings;
    global.SettingsScreen = SettingsScreen;
    global.CategoryEditor = CategoryEditor;
})(window);
