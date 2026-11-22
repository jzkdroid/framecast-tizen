/*
 * Programme guide: a grid of channels (rows) × time (two hours across, scrollable).
 * Guide data comes from Xtream's short EPG, loaded only for the rows on screen.
 *
 * ctx (from app.js): esc, timeText(ms), dayText(ms), channels(catId), pickerCategories(),
 *   categoryName(catId), epgFor(ch), loadEpg(ch, priority), play(ch, list, catId),
 *   isFav(ch), toggleFav(ch), close(), makeList(ul, rowHeight, renderRow)
 */
(function (global) {
    'use strict';

    var MIN = 60 * 1000;
    var HALF = 30 * MIN;
    var WINDOW = 120 * MIN;          // visible time span
    var GRID_X = 400;                // px from the guide's left edge to the first time column
    var GRID_W = 1392;               // px for the visible time span
    var ROW_H = 92;
    var PAST = -1e15, FUTURE = 1e15;

    function floorHalf(t) { return t - (t % HALF); }

    function el(tag, cls, text) {
        var node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function hideSelf() { this.style.visibility = 'hidden'; }

    function Guide(ctx) {
        this.ctx = ctx;
        this.el = {
            title: document.getElementById('guide-title'),
            day: document.getElementById('guide-day'),
            times: document.getElementById('guide-times'),
            body: document.getElementById('guide-body'),
            now: document.getElementById('guide-now'),
            infoTitle: document.getElementById('guide-info-title'),
            infoMeta: document.getElementById('guide-info-meta'),
            cats: document.getElementById('guide-cats')
        };
        this.catList = ctx.makeList(document.getElementById('guide-cat-list'), 72, function (cat, selected) {
            return '<li class="' + (selected ? 'selected' : '') + '"><span class="label">' +
                (cat.id === 'fav' ? '★ ' : '') + ctx.esc(cat.name) + '</span></li>';
        });
        this.picking = false;
        this.catId = 'all';
        this.row = 0;
        this.top = 0;
        this.rows = 8;
        this.epgTimer = null;
    }

    Guide.prototype.open = function (catId, channelId) {
        this.setCategory(catId, channelId);
        this.winStart = floorHalf(Date.now());
        this.focusTime = Date.now();
        this.closePicker();
        this.render();
    };

    Guide.prototype.setCategory = function (catId, channelId) {
        this.catId = catId;
        this.chans = this.ctx.channels(catId);
        if (!this.chans.length && catId !== 'all') { this.catId = 'all'; this.chans = this.ctx.channels('all'); }
        this.row = 0;
        if (channelId) {
            for (var i = 0; i < this.chans.length; i++) if (this.chans[i].id === channelId) { this.row = i; break; }
        }
        this.top = Math.max(0, this.row - 2);
    };

    /* ---------- programme cells for one channel, with fillers for gaps ---------- */

    Guide.prototype.cellsFor = function (ch) {
        var entry = this.ctx.epgFor(ch);
        if (!entry || entry.pending) return [{ start: PAST, end: FUTURE, kind: 'loading', title: 'Loading guide…' }];
        var items = entry.items || [];
        if (!items.length) return [{ start: PAST, end: FUTURE, kind: 'none', title: 'No guide information' }];
        var cells = [], t = PAST;
        items.forEach(function (p) {
            if (p.end <= t) return;                     // overlapping/duplicate listing
            var start = Math.max(p.start, t);
            if (start > t) cells.push({ start: t, end: start, kind: 'none', title: 'No information' });
            cells.push({ start: start, end: p.end, kind: 'prog', title: p.title, realStart: p.start });
            t = p.end;
        });
        cells.push({ start: t, end: FUTURE, kind: 'none', title: 'No information' });
        return cells;
    };

    function cellAt(cells, t) {
        for (var i = 0; i < cells.length; i++) if (cells[i].start <= t && t < cells[i].end) return i;
        return cells.length - 1;
    }

    /* ---------- rendering ---------- */

    Guide.prototype.visibleRows = function () {
        var h = this.el.body.clientHeight;
        if (h > 0) this.rows = Math.max(1, Math.floor(h / ROW_H));
        return this.rows;
    };

    Guide.prototype.render = function () {
        var ctx = this.ctx, self = this;
        var now = Date.now();
        var winStart = this.winStart, winEnd = winStart + WINDOW;
        var pxPerMs = GRID_W / WINDOW;
        var n = this.visibleRows();

        if (this.row < this.top) this.top = this.row;
        if (this.row >= this.top + n) this.top = this.row - n + 1;
        this.top = Math.max(0, Math.min(this.top, Math.max(0, this.chans.length - n)));

        this.el.title.textContent = 'Guide · ' + ctx.categoryName(this.catId);
        this.el.day.textContent = ctx.dayText(winStart);

        // Built with DOM calls, not HTML strings: positions are set through element.style,
        // which the app's content security policy allows (inline style="" attributes are blocked).
        var ticks = document.createDocumentFragment();
        for (var t = winStart; t < winEnd; t += HALF) {
            var tick = el('span', 'gtick', ctx.timeText(t));
            tick.style.left = Math.round((t - winStart) * pxPerMs) + 'px';
            ticks.appendChild(tick);
        }
        this.el.times.innerHTML = '';
        this.el.times.appendChild(ticks);

        var body = document.createDocumentFragment(), focused = null, focusedCh = null;
        for (var r = this.top; r < Math.min(this.chans.length, this.top + n); r++) {
            var ch = this.chans[r];
            var cells = this.cellsFor(ch);
            var isRow = r === this.row;
            var fi = isRow ? cellAt(cells, this.focusTime) : -1;

            var row = el('div', 'grow' + (isRow ? ' current' : ''));
            row.style.top = ((r - this.top) * ROW_H) + 'px';
            var chanCell = el('div', 'gchan');
            chanCell.appendChild(el('span', 'gnum', String(ch.num)));
            if (ch.logo) {
                var img = el('img', 'glogo');
                img.alt = '';
                img.onerror = hideSelf;
                img.src = ch.logo;
                chanCell.appendChild(img);
            } else {
                chanCell.appendChild(el('span', 'glogo'));
            }
            chanCell.appendChild(el('span', 'gname', ch.name));
            if (ctx.isFav(ch)) chanCell.appendChild(el('span', 'gfav', '★'));
            row.appendChild(chanCell);

            for (var c = 0; c < cells.length; c++) {
                var cell = cells[c];
                if (cell.end <= winStart || cell.start >= winEnd) continue;
                var left = Math.max(cell.start, winStart), right = Math.min(cell.end, winEnd);
                var w = Math.max(4, Math.round((right - left) * pxPerMs) - 6);
                var live = cell.kind === 'prog' && cell.start <= now && now < cell.end;
                var box = el('div', 'gcell ' + cell.kind + (live ? ' live' : '') + (c === fi ? ' focused' : '') +
                    (cell.start < winStart ? ' clipped' : ''));
                box.style.left = (GRID_X + Math.round((left - winStart) * pxPerMs)) + 'px';
                box.style.width = w + 'px';
                box.appendChild(el('span', 'gtitle', (cell.start < winStart && cell.kind === 'prog' ? '‹ ' : '') + cell.title));
                if (cell.kind === 'prog' && w > 150) box.appendChild(el('span', 'gtime', ctx.timeText(cell.realStart || cell.start)));
                row.appendChild(box);
                if (c === fi) { focused = cell; focusedCh = ch; }
            }
            if (isRow && fi !== -1 && !focused) { focused = cells[fi]; focusedCh = ch; }
            body.appendChild(row);
        }
        this.el.body.innerHTML = '';
        this.el.body.appendChild(body);

        if (now >= winStart && now < winEnd) {
            this.el.now.style.left = (GRID_X + Math.round((now - winStart) * pxPerMs)) + 'px';
            this.el.now.classList.remove('hidden');
        } else {
            this.el.now.classList.add('hidden');
        }

        this.renderInfo(focused, focusedCh, now);

        clearTimeout(this.epgTimer);
        this.epgTimer = setTimeout(function () {
            var cur = self.chans[self.row];
            if (cur) ctx.loadEpg(cur, true);
            self.chans.slice(self.top, self.top + n).forEach(function (c) { ctx.loadEpg(c, false); });
        }, 150);
    };

    Guide.prototype.renderInfo = function (cell, ch, now) {
        var ctx = this.ctx;
        if (!ch) { this.el.infoTitle.textContent = this.chans.length ? '' : 'No channels in this category'; this.el.infoMeta.textContent = ''; return; }
        if (!cell || cell.kind !== 'prog') {
            this.el.infoTitle.textContent = ch.name;
            this.el.infoMeta.textContent = cell && cell.kind === 'loading' ? 'Loading guide…' : 'No guide information for this time';
            return;
        }
        var start = cell.realStart || cell.start;
        var live = start <= now && now < cell.end;
        var mins = Math.round((cell.end - start) / MIN);
        this.el.infoTitle.textContent = (live ? 'Now · ' : '') + cell.title;
        this.el.infoMeta.textContent = ch.num + ' ' + ch.name + '  ·  ' + ctx.dayText(start) + ' ' +
            ctx.timeText(start) + '–' + ctx.timeText(cell.end) + '  ·  ' + mins + ' min' +
            (live ? '  ·  ' + Math.max(0, Math.round((cell.end - now) / MIN)) + ' min left' : '');
    };

    /* ---------- category picker (opens with ◀ at the earliest time) ---------- */

    Guide.prototype.openPicker = function () {
        var cats = this.ctx.pickerCategories(), sel = 0, self = this;
        cats.forEach(function (c, i) { if (c.id === self.catId) sel = i; });
        this.picking = true;
        this.el.cats.classList.remove('hidden');
        this.catList.setItems(cats, sel);
    };

    Guide.prototype.closePicker = function () {
        this.picking = false;
        this.el.cats.classList.add('hidden');
    };

    /* ---------- keys ---------- */

    Guide.prototype.onKey = function (a) {
        if (this.picking) {
            switch (a) {
                case 'up': case 'down': this.catList.move(a === 'up' ? -1 : 1); return true;
                case 'chup': case 'chdown': this.catList.move((a === 'chup' ? -1 : 1) * this.catList.visibleCount()); return true;
                case 'ok': case 'right': {
                    var cat = this.catList.current();
                    this.closePicker();
                    if (cat && cat.id !== this.catId) this.setCategory(cat.id);
                    this.render();
                    return true;
                }
                case 'back': case 'left': this.closePicker(); return true;
            }
            return true;
        }

        var ch = this.chans[this.row];
        var guideMin = floorHalf(Date.now());
        switch (a) {
            case 'up': case 'down':
                if (!this.chans.length) return true;
                this.row = Math.max(0, Math.min(this.chans.length - 1, this.row + (a === 'up' ? -1 : 1)));
                this.render();
                return true;
            case 'chup': case 'chdown':
                if (!this.chans.length) return true;
                this.row = Math.max(0, Math.min(this.chans.length - 1, this.row + (a === 'chup' ? -1 : 1) * this.visibleRows()));
                this.render();
                return true;
            case 'right': {
                if (!ch) return true;
                var cells = this.cellsFor(ch), cur = cells[cellAt(cells, this.focusTime)];
                var t = (cur.end - this.focusTime > WINDOW) ? floorHalf(this.focusTime) + HALF : cur.end;
                if (t > Date.now() + 36 * 60 * MIN) return true;
                this.focusTime = t;
                while (this.focusTime >= this.winStart + WINDOW) this.winStart += HALF;
                this.render();
                return true;
            }
            case 'left': {
                if (!ch) { this.openPicker(); return true; }
                var cs = this.cellsFor(ch), curL = cs[cellAt(cs, this.focusTime)];
                var atStart = curL.start <= guideMin;
                if (atStart) {
                    if (this.winStart > guideMin) {
                        this.winStart -= HALF;
                        this.focusTime = Math.max(guideMin, this.winStart);
                    } else {
                        this.openPicker();
                        return true;
                    }
                } else {
                    var prev = cs[cellAt(cs, curL.start - 1)];
                    var target = (curL.start - prev.start > WINDOW) ? curL.start - HALF : prev.start;
                    this.focusTime = Math.max(guideMin, target);
                    while (this.focusTime < this.winStart) this.winStart -= HALF;
                }
                this.render();
                return true;
            }
            case 'ok': case 'play': case 'playpause':
                if (ch) this.ctx.play(ch, this.chans, this.catId);
                return true;
            case 'red':
                if (ch) { this.ctx.toggleFav(ch); if (this.catId === 'fav') this.setCategory('fav', ch.id); this.render(); }
                return true;
            case 'green': case 'back':
                this.ctx.close();
                return true;
        }
        return false;
    };

    /** Called when guide data arrives for a channel. */
    Guide.prototype.epgUpdated = function (ch) {
        var n = this.visibleRows();
        var visible = this.chans.slice(this.top, this.top + n);
        if (visible.indexOf(ch) !== -1) this.render();
    };

    global.Guide = Guide;
})(window);
