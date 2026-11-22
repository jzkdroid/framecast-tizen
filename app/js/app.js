/* FrameCast — screens, remote navigation, channel lists, guide, favorites and search. */
(function (global) {
    'use strict';

    var Store = global.Store, Xtream = global.Xtream, Player = global.Player, Keys = global.Keys;

    function $(id) { return document.getElementById(id); }

    function esc(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function pad(n) { return (n < 10 ? '0' : '') + n; }

    function clockText(ms) {
        var d = new Date(ms);
        var h = d.getHours(), m = d.getMinutes();
        var ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        return h + ':' + pad(m) + ' ' + ampm;
    }

    function shortTime(ms) {
        var d = new Date(ms);
        var h = d.getHours() % 12 || 12;
        return h + ':' + pad(d.getMinutes());
    }

    /* ------------------------------------------------------------------ */
    /* Virtual list: only the rows on screen exist in the DOM.             */
    /* ------------------------------------------------------------------ */

    function VList(ul, rowHeight, renderRow) {
        this.ul = ul;
        this.rowHeight = rowHeight;
        this.renderRow = renderRow;
        this.items = [];
        this.sel = 0;
        this.top = 0;
    }

    VList.prototype.visibleCount = function () {
        // While its screen is hidden the list measures 0 px; keep the last real size.
        var h = this.ul.clientHeight;
        if (h > 0) this.lastCount = Math.max(1, Math.floor(h / this.rowHeight));
        return this.lastCount || 8;
    };

    VList.prototype.setItems = function (items, sel) {
        this.items = items;
        this.sel = Math.max(0, Math.min(sel || 0, items.length - 1));
        this.top = 0;
        this.render();
    };

    VList.prototype.move = function (delta) {
        if (!this.items.length) return false;
        var next = Math.max(0, Math.min(this.items.length - 1, this.sel + delta));
        if (next === this.sel) return false;
        this.sel = next;
        this.render();
        return true;
    };

    VList.prototype.current = function () { return this.items[this.sel]; };

    VList.prototype.visibleItems = function () {
        return this.items.slice(this.top, this.top + this.visibleCount());
    };

    VList.prototype.render = function () {
        var n = this.visibleCount();
        if (this.sel < this.top) this.top = this.sel;
        if (this.sel >= this.top + n) this.top = this.sel - n + 1;
        this.top = Math.max(0, Math.min(this.top, Math.max(0, this.items.length - n)));
        var html = '';
        for (var i = this.top; i < Math.min(this.items.length, this.top + n); i++) {
            html += this.renderRow(this.items[i], i === this.sel);
        }
        this.ul.innerHTML = html;
        // Broken channel logos: hide instead of showing a broken-image icon.
        Array.prototype.forEach.call(this.ul.querySelectorAll('img'), function (img) {
            img.onerror = function () { img.style.visibility = 'hidden'; };
        });
    };

    /* ------------------------------------------------------------------ */
    /* State                                                               */
    /* ------------------------------------------------------------------ */

    var S = {
        screen: 'login',
        zone: 'cat',              // browse focus: 'cat' | 'chan' | 'search'
        api: null,
        accountKey: '',
        categories: [],
        channels: [],
        byCat: {},
        byNum: {},
        favs: [],
        epg: {},                  // streamId -> { at, items } | { pending: true }
        playing: null,            // channel object
        playingList: [],
        searchText: '',
        lastSel: {}               // category id -> selected channel id
    };

    var catList, chanList;
    var timers = {};

    function later(name, ms, fn) {
        clearTimeout(timers[name]);
        timers[name] = setTimeout(fn, ms);
    }

    function toast(text, ms) {
        var el = $('toast');
        el.textContent = text;
        el.classList.remove('hidden');
        later('toast', ms || 2200, function () { el.classList.add('hidden'); });
    }

    function showScreen(name) {
        S.screen = name;
        ['login', 'browse', 'player'].forEach(function (n) {
            $(n + '-screen').classList.toggle('hidden', n !== name);
        });
        document.body.classList.toggle('playing', name === 'player');
    }

    /* ------------------------------------------------------------------ */
    /* Login                                                               */
    /* ------------------------------------------------------------------ */

    var loginFields = ['login-url', 'login-user', 'login-pass', 'login-btn'];
    var loginFocus = 0;

    function renderLoginFocus() {
        loginFields.forEach(function (id, i) { $(id).classList.toggle('focused', i === loginFocus); });
    }

    function showLogin(message, saved) {
        showScreen('login');
        if (saved) {
            $('login-url').value = saved.server || '';
            $('login-user').value = saved.username || '';
            $('login-pass').value = saved.password || '';
        }
        $('login-error').textContent = message || '';
        $('login-btn').disabled = false;
        loginFocus = $('login-url').value ? 3 : 0;
        renderLoginFocus();
    }

    function submitLogin() {
        var account = {
            server: Xtream.normalizeServer($('login-url').value),
            username: $('login-user').value.trim(),
            password: $('login-pass').value
        };
        connect(account, true);
    }

    // Waits before each automatic retry of sign-in / channel loading. Right after the TV
    // wakes up its network often isn't connected yet, so the first try commonly fails.
    var CONNECT_RETRY_DELAYS = [3, 6, 10, 15];

    function connect(account, fromForm, attemptNo) {
        var attemptIndex = attemptNo || 0;
        var api = new Xtream(account.server, account.username, account.password);
        $('login-btn').disabled = true;
        $('login-error').textContent = attemptIndex ? 'Signing in (attempt ' + (attemptIndex + 1) + ')…' : 'Signing in…';
        api.login().then(function () {
            $('login-error').textContent = 'Loading channels…';
            return Promise.all([api.liveCategories(), api.liveStreams()]);
        }).then(function (res) {
            Store.write('account', account);
            S.api = api;
            S.accountKey = api.server + '|' + api.username;
            S.favs = Store.read('favs:' + S.accountKey, []);
            S.lastSel = Store.read('lastSel:' + S.accountKey, {});
            buildLibrary(res[0], res[1]);
            enterBrowse();
        }).catch(function (err) {
            var wait = CONNECT_RETRY_DELAYS[attemptIndex];
            if (!err.permanent && wait) {
                retryCountdown(err.message || 'Could not reach the server', wait, function () {
                    connect(account, fromForm, attemptIndex + 1);
                });
                return;
            }
            showLogin((err.message || 'Sign-in failed') +
                (err.permanent ? '' : '. Check your internet connection, then press Sign in to try again.'),
                fromForm ? null : account);
        });
    }

    function retryCountdown(reason, seconds, then) {
        showScreen('login');
        $('login-btn').disabled = true;
        var left = seconds;
        (function tick() {
            $('login-error').textContent = reason + '. Trying again in ' + left + ' s…';
            if (left-- <= 0) { then(); return; }
            later('connectRetry', 1000, tick);
        })();
    }

    function signOut() {
        Player.stop();
        S.playing = null;
        Store.remove('account');
        S.api = null;
        S.channels = [];
        S.epg = {};
        showLogin('Signed out.', null);
        $('login-pass').value = '';
    }

    /* ------------------------------------------------------------------ */
    /* Library                                                             */
    /* ------------------------------------------------------------------ */

    function buildLibrary(cats, chans) {
        S.channels = chans;
        S.byCat = {};
        S.byNum = {};
        chans.forEach(function (c) {
            (S.byCat[c.cat] = S.byCat[c.cat] || []).push(c);
            if (!S.byNum[c.num]) S.byNum[c.num] = c;
        });
        S.categories = [
            { id: 'fav', name: 'Favorites', special: true },
            { id: 'all', name: 'All channels', special: true },
            { id: 'search', name: 'Search', special: true }
        ].concat(cats.filter(function (c) { return S.byCat[c.id] && S.byCat[c.id].length; }));
        var known = {};
        cats.forEach(function (c) { known[c.id] = true; });
        var orphans = chans.filter(function (c) { return !known[c.cat]; });
        if (orphans.length) {
            S.byCat.other = orphans;
            S.categories.push({ id: 'other', name: 'Other' });
        }
    }

    function channelsFor(catId) {
        if (catId === 'all') return S.channels;
        if (catId === 'fav') {
            return S.favs.map(function (id) {
                for (var i = 0; i < S.channels.length; i++) if (S.channels[i].id === id) return S.channels[i];
                return null;
            }).filter(Boolean);
        }
        if (catId === 'search') return searchResults(S.searchText);
        return S.byCat[catId] || [];
    }

    function countFor(cat) {
        if (cat.id === 'search') return '';
        if (cat.id === 'fav') return S.favs.length;
        if (cat.id === 'all') return S.channels.length;
        return (S.byCat[cat.id] || []).length;
    }

    function searchResults(text) {
        var q = String(text || '').trim().toLowerCase();
        if (!q) return [];
        var out = [];
        for (var i = 0; i < S.channels.length && out.length < 500; i++) {
            if (S.channels[i].name.toLowerCase().indexOf(q) !== -1) out.push(S.channels[i]);
        }
        return out;
    }

    function isFav(ch) { return ch && S.favs.indexOf(ch.id) !== -1; }

    function toggleFav(ch) {
        if (!ch) return;
        var i = S.favs.indexOf(ch.id);
        if (i === -1) { S.favs.push(ch.id); toast('★ Added ' + ch.name + ' to Favorites'); }
        else { S.favs.splice(i, 1); toast('Removed ' + ch.name + ' from Favorites'); }
        Store.write('favs:' + S.accountKey, S.favs);
        catList.render();
        if (currentCat().id === 'fav') {
            loadChannels(Math.min(chanList.sel, S.favs.length - 1));
        } else {
            chanList.render();
        }
        if (S.screen === 'player') renderOsd();
    }

    /* ------------------------------------------------------------------ */
    /* Browse screen                                                       */
    /* ------------------------------------------------------------------ */

    function renderCategoryRow(cat, selected) {
        var icon = cat.id === 'fav' ? '★ ' : cat.id === 'search' ? '⌕ ' : '';
        return '<li class="' + (selected ? 'selected' : '') + '"><span class="label">' + icon + esc(cat.name) +
            '</span><span class="count">' + esc(countFor(cat)) + '</span></li>';
    }

    function renderChannelRow(ch, selected) {
        var now = nowPlaying(ch);
        var playing = S.playing && S.playing.id === ch.id;
        return '<li class="' + (selected ? 'selected' : '') + '">' +
            '<span class="ch-num">' + ch.num + '</span>' +
            (ch.logo ? '<img class="ch-logo" src="' + esc(ch.logo) + '" alt="">' : '<span class="ch-logo"></span>') +
            '<span class="ch-text"><span class="label">' + (playing ? '▶ ' : '') + esc(ch.name) + '</span>' +
            '<span class="now">' + esc(now ? now.title : '') + '</span></span>' +
            (isFav(ch) ? '<span class="fav-mark">★</span>' : '') +
            '</li>';
    }

    function currentCat() { return catList.current() || S.categories[0]; }

    function enterBrowse() {
        showScreen('browse');
        var last = Store.read('lastCat:' + S.accountKey, 'all');
        var idx = 0;
        S.categories.forEach(function (c, i) { if (c.id === last) idx = i; });
        if (last === 'fav' && !S.favs.length) idx = 1;
        catList.setItems(S.categories, idx);
        loadChannels();
        setZone(chanList.items.length ? 'chan' : 'cat');
        updateClock();
    }

    function loadChannels(selIndex) {
        var cat = currentCat();
        loadedCatId = cat.id;
        var items = channelsFor(cat.id);
        var sel = selIndex;
        if (sel === undefined) {
            sel = 0;
            var lastId = S.lastSel[cat.id];
            if (lastId) items.forEach(function (c, i) { if (c.id === lastId) sel = i; });
        }
        $('channel-title').textContent = cat.name + (cat.id === 'search' ? '' : ' · ' + items.length);
        $('search-box').classList.toggle('hidden', cat.id !== 'search');
        chanList.setItems(items, sel);
        var empty = $('channel-empty');
        if (!items.length) {
            empty.textContent = cat.id === 'fav'
                ? 'No favorites yet. Highlight a channel and press the red button to add it.'
                : cat.id === 'search'
                    ? (S.searchText ? 'No channels match "' + S.searchText + '".' : 'Press OK to type a channel name.')
                    : 'This category is empty.';
            empty.classList.remove('hidden');
        } else {
            empty.classList.add('hidden');
        }
        channelChanged();
    }

    function setZone(zone) {
        S.zone = zone;
        catList.ul.classList.toggle('active', zone === 'cat');
        chanList.ul.classList.toggle('active', zone === 'chan');
        var input = $('search-input');
        input.classList.toggle('focused', zone === 'search');
        if (zone === 'search') {
            input.focus();
        } else if (document.activeElement === input) {
            input.blur();
        }
    }

    function channelChanged() {
        var ch = chanList.current();
        if (ch) {
            S.lastSel[currentCat().id] = ch.id;
            later('saveSel', 1000, function () { Store.write('lastSel:' + S.accountKey, S.lastSel); });
        }
        renderDetails();
        later('epgSel', 250, function () {
            if (ch) loadEpg(ch, true);
            later('epgRows', 400, function () { chanList.visibleItems().forEach(function (c) { loadEpg(c, false); }); });
        });
    }

    function renderDetails() {
        var ch = chanList.current();
        $('detail-name').textContent = ch ? ch.name : '';
        var ol = $('detail-epg');
        if (!ch) { ol.innerHTML = ''; return; }
        var entry = S.epg[ch.id];
        if (!entry || entry.pending) { ol.innerHTML = '<li class="note">Loading guide…</li>'; return; }
        var now = Date.now();
        var items = entry.items.filter(function (p) { return p.end > now; }).slice(0, 6);
        if (!items.length) { ol.innerHTML = '<li class="note">No guide information for this channel.</li>'; return; }
        ol.innerHTML = items.map(function (p) {
            var on = p.start <= now && p.end > now;
            return '<li class="' + (on ? 'now' : '') + '"><span class="t">' + (on ? 'Now' : shortTime(p.start)) +
                '</span><span class="p">' + esc(p.title) + '</span></li>';
        }).join('');
    }

    function updateClock() {
        $('clock').textContent = clockText(Date.now());
    }

    function setPreviewLive(on) {
        $('preview').classList.toggle('live', on);
        document.body.classList.toggle('video-under', on);
    }

    function previewRect() {
        var r = $('preview').getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    }

    function backToBrowse() {
        showScreen('browse');
        catList.render();
        chanList.render();
        if (S.playing) {
            Player.setRect(previewRect());
            setPreviewLive(true);
            // Highlight the playing channel in the current list if it's there.
            chanList.items.forEach(function (c, i) { if (c.id === S.playing.id) chanList.sel = i; });
            chanList.render();
            channelChanged();
            setZone('chan');
        }
    }

    function stopPreview() {
        Player.stop();
        S.playing = null;
        setPreviewLive(false);
        chanList.render();
    }

    /* ------------------------------------------------------------------ */
    /* Guide (EPG)                                                         */
    /* ------------------------------------------------------------------ */

    var epgQueue = [];
    var epgActive = 0;

    function epgFresh(entry) {
        if (!entry || entry.pending) return false;
        if (Date.now() - entry.at > 10 * 60 * 1000) return false;
        // Stale once the programme that was "now" has ended and nothing follows.
        var now = Date.now();
        return entry.items.length === 0 || entry.items.some(function (p) { return p.end > now; });
    }

    function loadEpg(ch, priority) {
        if (!S.api || epgFresh(S.epg[ch.id]) || (S.epg[ch.id] && S.epg[ch.id].pending)) return;
        var already = epgQueue.indexOf(ch);
        if (already !== -1) {
            if (priority) { epgQueue.splice(already, 1); epgQueue.unshift(ch); }
            return;
        }
        if (priority) epgQueue.unshift(ch); else epgQueue.push(ch);
        if (epgQueue.length > 30) epgQueue.length = 30;
        pumpEpg();
    }

    function pumpEpg() {
        while (epgActive < 2 && epgQueue.length) {
            (function (ch) {
                epgActive++;
                S.epg[ch.id] = { pending: true };
                S.api.shortEpg(ch.id, 8).then(function (items) {
                    S.epg[ch.id] = { at: Date.now(), items: items };
                }).catch(function () {
                    S.epg[ch.id] = { at: Date.now(), items: [] };
                }).then(function () {
                    epgActive--;
                    epgUpdated(ch);
                    pumpEpg();
                });
            })(epgQueue.shift());
        }
    }

    function epgUpdated(ch) {
        if (S.screen === 'browse') {
            var cur = chanList.current();
            if (cur && cur.id === ch.id) renderDetails();
            if (chanList.visibleItems().indexOf(ch) !== -1) chanList.render();
        }
        if (S.screen === 'player' && S.playing && S.playing.id === ch.id) renderOsd();
    }

    function nowPlaying(ch) {
        var entry = S.epg[ch.id];
        if (!entry || !entry.items) return null;
        var now = Date.now();
        for (var i = 0; i < entry.items.length; i++) {
            if (entry.items[i].start <= now && entry.items[i].end > now) return entry.items[i];
        }
        return null;
    }

    function nextUp(ch) {
        var entry = S.epg[ch.id];
        if (!entry || !entry.items) return null;
        var now = Date.now();
        for (var i = 0; i < entry.items.length; i++) {
            if (entry.items[i].start > now) return entry.items[i];
        }
        return null;
    }

    /* ------------------------------------------------------------------ */
    /* Player screen                                                       */
    /* ------------------------------------------------------------------ */

    function play(ch, list) {
        // Re-selecting the channel that's already on just goes full screen, unless it failed:
        // then choosing it again is a retry.
        var sameChannel = S.playing && S.playing.id === ch.id && Player.isPlaying() && !Player.hasFailed();
        S.playing = ch;
        S.playingList = list && list.length ? list.slice() : [ch];
        Store.write('lastChannel:' + S.accountKey, ch.id);
        showScreen('player');
        setPreviewLive(false);
        Player.setRect(null);
        if (!sameChannel) {
            hideStatus();
            Player.play(S.api.streamUrl(ch.id));
        }
        loadEpg(ch, true);
        showOsd();
    }

    function zap(delta) {
        if (!S.playing) return;
        var list = S.playingList;
        var i = list.indexOf(S.playing);
        if (i === -1) i = 0;
        var next = list[(i + delta + list.length) % list.length];
        if (next) play(next, list);
    }

    function renderOsd() {
        var ch = S.playing;
        if (!ch) return;
        $('osd-num').textContent = ch.num;
        var logo = $('osd-logo');
        if (ch.logo) { logo.src = ch.logo; logo.style.visibility = 'visible'; }
        else logo.style.visibility = 'hidden';
        logo.onerror = function () { logo.style.visibility = 'hidden'; };
        $('osd-name').textContent = ch.name;
        $('osd-fav').textContent = isFav(ch) ? '★' : '';
        var now = nowPlaying(ch), next = nextUp(ch);
        var entry = S.epg[ch.id];
        $('osd-now').textContent = now
            ? 'Now: ' + now.title + '  ·  ' + shortTime(now.start) + '–' + shortTime(now.end)
            : (entry && entry.pending ? 'Loading guide…' : 'No guide information');
        $('osd-bar').style.width = now
            ? Math.max(0, Math.min(100, (Date.now() - now.start) / (now.end - now.start) * 100)) + '%' : '0';
        $('osd-next').textContent = next ? 'Next: ' + shortTime(next.start) + '  ' + next.title : '';
    }

    function showOsd() {
        renderOsd();
        $('osd').classList.remove('faded');
        later('osd', 5000, function () { $('osd').classList.add('faded'); });
    }

    function showStatus(text) {
        var el = $('player-status');
        el.textContent = text;
        el.classList.remove('hidden');
    }

    function hideStatus() { $('player-status').classList.add('hidden'); }

    Player.setListener({
        onStatus: function (text) {
            if (S.screen !== 'player') return;
            if (text) showStatus(text); else hideStatus();
        },
        onError: function (message) {
            if (S.screen === 'player') { showStatus(message + '\nPress OK to try again.'); showOsd(); }
            else toast(message, 4000);
        }
    });

    /* ------------------------------------------------------------------ */
    /* Number entry (type a channel number on the remote)                  */
    /* ------------------------------------------------------------------ */

    var digits = '';

    function typeDigit(d) {
        if (!S.channels.length) return;
        digits = (digits + d).slice(0, 5);
        toast('Channel ' + digits, 1600);
        later('digits', 1500, function () {
            var ch = S.byNum[parseInt(digits, 10)];
            digits = '';
            if (!ch) { toast('No channel with that number'); return; }
            if (S.screen === 'player') {
                play(ch, S.channels);
            } else {
                catList.sel = 1; // All channels
                catList.render();
                loadChannels(S.channels.indexOf(ch));
                setZone('chan');
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /* Keys                                                                */
    /* ------------------------------------------------------------------ */

    var exitArmed = false, signOutArmed = false;

    function armOnce(flag, text, fn) {
        if (flag === 'exit' ? exitArmed : signOutArmed) { fn(); return; }
        if (flag === 'exit') exitArmed = true; else signOutArmed = true;
        toast(text, 2500);
        later('arm' + flag, 2500, function () { exitArmed = false; signOutArmed = false; });
    }

    function onLoginKey(a) {
        var el = $(loginFields[loginFocus]);
        var typing = document.activeElement && document.activeElement.tagName === 'INPUT';
        if (typing) {
            if (a === 'ok' || a === 'imedone' || a === 'down') { document.activeElement.blur(); loginFocus = Math.min(3, loginFocus + 1); renderLoginFocus(); return true; }
            if (a === 'up') { document.activeElement.blur(); loginFocus = Math.max(0, loginFocus - 1); renderLoginFocus(); return true; }
            if (a === 'back' || a === 'imecancel') { document.activeElement.blur(); return true; }
            return false;
        }
        switch (a) {
            case 'up': loginFocus = Math.max(0, loginFocus - 1); renderLoginFocus(); return true;
            case 'down': loginFocus = Math.min(3, loginFocus + 1); renderLoginFocus(); return true;
            case 'ok':
                if (el.tagName === 'BUTTON') { if (!el.disabled) submitLogin(); }
                else el.focus();
                return true;
            case 'back': armOnce('exit', 'Press BACK again to exit', Keys.exitApp); return true;
        }
        return false;
    }

    function onBrowseKey(a) {
        if (S.zone === 'search') {
            if (a === 'ok' || a === 'imedone' || a === 'down') {
                setZone(chanList.items.length ? 'chan' : 'cat');
                return true;
            }
            if (a === 'up' || a === 'back' || a === 'imecancel') { setZone('cat'); return true; }
            return false;   // typing
        }

        if (/^\d$/.test(a)) { typeDigit(a); return true; }

        switch (a) {
            case 'yellow':
                S.categories.forEach(function (c, i) { if (c.id === 'search') catList.sel = i; });
                catList.render();
                loadChannels();
                setZone('search');
                return true;
            case 'blue':
                armOnce('signout', 'Press the blue button again to sign out', signOut);
                return true;
            case 'green':
                return true;
        }

        if (S.zone === 'cat') {
            switch (a) {
                case 'up': case 'down':
                    if (catList.move(a === 'up' ? -1 : 1)) {
                        later('catLoad', 120, function () { loadChannels(); });
                    }
                    return true;
                case 'chup': case 'chdown':
                    if (catList.move(a === 'chup' ? -catList.visibleCount() : catList.visibleCount())) loadChannels();
                    return true;
                case 'right': case 'ok':
                    clearTimeout(timers.catLoad);
                    if (chanList.items.length === 0 || currentCat().id !== channelsCatId()) loadChannels();
                    if (currentCat().id === 'search' && (a === 'ok' || !chanList.items.length)) setZone('search');
                    else if (chanList.items.length) setZone('chan');
                    return true;
                case 'back':
                    if (S.playing) { stopPreview(); return true; }
                    armOnce('exit', 'Press BACK again to exit', Keys.exitApp);
                    return true;
            }
            return false;
        }

        // zone === 'chan'
        switch (a) {
            case 'up': case 'down':
                if (chanList.move(a === 'up' ? -1 : 1)) channelChanged();
                return true;
            case 'chup': case 'chdown':
                if (chanList.move(a === 'chup' ? -chanList.visibleCount() : chanList.visibleCount())) channelChanged();
                return true;
            case 'left':
                setZone(currentCat().id === 'search' ? 'search' : 'cat');
                return true;
            case 'ok': case 'play': case 'playpause':
                if (chanList.current()) play(chanList.current(), chanList.items);
                return true;
            case 'red':
                toggleFav(chanList.current());
                return true;
            case 'info':
                var ch = chanList.current();
                if (ch) { delete S.epg[ch.id]; loadEpg(ch, true); renderDetails(); }
                return true;
            case 'back':
                if (S.playing) { stopPreview(); return true; }
                setZone('cat');
                return true;
        }
        return false;
    }

    // Which category's channels are on screen (the category column loads them after a short delay).
    var loadedCatId = null;
    function channelsCatId() { return loadedCatId; }

    function onPlayerKey(a) {
        if (/^\d$/.test(a)) { typeDigit(a); return true; }
        switch (a) {
            case 'up': case 'chup': zap(1); return true;
            case 'down': case 'chdown': zap(-1); return true;
            case 'ok':
                if (Player.hasFailed()) { hideStatus(); Player.retry(); showOsd(); return true; }
                showOsd();
                return true;
            case 'info': case 'left': case 'right': showOsd(); return true;
            case 'red': toggleFav(S.playing); showOsd(); return true;
            case 'back': hideStatus(); backToBrowse(); return true;
            case 'stop': hideStatus(); stopPreview(); backToBrowse(); return true;
        }
        return false;
    }

    document.addEventListener('keydown', function (e) {
        var typing = document.activeElement && document.activeElement.tagName === 'INPUT';
        var a = Keys.actionFor(e, typing);
        if (!a) return;
        var handled = false;
        if (S.screen === 'login') handled = onLoginKey(a);
        else if (S.screen === 'browse') handled = onBrowseKey(a);
        else if (S.screen === 'player') handled = onPlayerKey(a);
        if (handled) e.preventDefault();
    });

    /* ------------------------------------------------------------------ */
    /* Startup                                                             */
    /* ------------------------------------------------------------------ */

    function init() {
        Keys.register();

        catList = new VList($('category-list'), 72, renderCategoryRow);
        chanList = new VList($('channel-list'), 88, renderChannelRow);

        $('search-input').addEventListener('input', function () {
            S.searchText = this.value;
            later('search', 250, function () { loadChannels(0); });
        });
        $('search-input').addEventListener('focus', function () { if (S.zone !== 'search') setZone('search'); });

        Array.prototype.forEach.call(document.querySelectorAll('#login-screen input'), function (input, i) {
            input.addEventListener('focus', function () { loginFocus = i; renderLoginFocus(); });
        });
        $('login-btn').addEventListener('click', submitLogin);

        document.addEventListener('visibilitychange', function () {
            if (document.hidden) Player.suspend(); else Player.resume();
        });

        setInterval(function () {
            updateClock();
            if (S.screen === 'player') renderOsd();
            if (S.screen === 'browse') renderDetails();
        }, 30000);

        var saved = Store.read('account', null);
        if (saved && saved.server && saved.username) {
            showLogin('', saved);
            connect(saved, false);
        } else {
            showLogin('', null);
        }
    }

    init();

    // Exposed for debugging from the dev tools console.
    global.FrameCast = { state: S };
})(window);
