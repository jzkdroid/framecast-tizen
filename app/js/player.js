/*
 * Video playback.
 * On the TV: Samsung AVPlay (hardware decoding, plays MPEG-TS and HLS directly).
 * In a desktop browser (development only): <video> + hls.js if the dev server provided it.
 */
(function (global) {
    'use strict';

    var FULL = { x: 0, y: 0, w: 1920, h: 1080 };

    var avplay = global.webapis && global.webapis.avplay;
    var avEl = document.getElementById('av-player');
    var htmlEl = document.getElementById('html-player');

    var listener = null;   // { onStatus(text|null), onError(message) }
    var currentUrl = null;
    var rect = FULL;
    var hls = null;
    var playToken = 0;     // ignores callbacks from a stream we already left

    var START_TIMEOUT_MS = 15000;
    var watchdog = null;
    var failedToken = -1;  // once a stream has failed, its late "Loading…" events must not hide the error

    function status(text) {
        if (failedToken === playToken) return;
        // Any "not loading" status means the picture is moving: stop the start-up watchdog.
        if (!text) clearTimeout(watchdog);
        if (listener && listener.onStatus) listener.onStatus(text);
    }
    function fail(message) {
        clearTimeout(watchdog);
        if (failedToken === playToken) return;
        failedToken = playToken;
        if (listener && listener.onError) listener.onError(message);
    }

    // Dead channels often never error out (endless retries); give up after a while.
    function armWatchdog(token) {
        clearTimeout(watchdog);
        watchdog = setTimeout(function () {
            if (token === playToken) fail('This channel isn\'t responding. It may be offline; try another channel.');
        }, START_TIMEOUT_MS);
    }

    function placeElement(el, r) {
        el.style.left = r.x + 'px';
        el.style.top = r.y + 'px';
        el.style.width = r.w + 'px';
        el.style.height = r.h + 'px';
    }

    /* ---------------- AVPlay (TV) ---------------- */

    function avplayState() {
        try { return avplay.getState(); } catch (e) { return 'NONE'; }
    }

    function avplayStop() {
        try {
            var s = avplayState();
            if (s === 'PLAYING' || s === 'PAUSED' || s === 'READY') avplay.stop();
            if (s !== 'NONE') avplay.close();
        } catch (e) { /* already closed */ }
    }

    /*
     * Xtream panels answer stream URLs with a redirect to a CDN (often with an unusual
     * "...&secret_token=" URL). AVPlay fails to follow it (PLAYER_ERROR_CONNECTION_FAILED),
     * so follow the redirect here and give AVPlay the final address.
     */
    function resolveRedirect(url, cb) {
        var xhr = new XMLHttpRequest();
        var done = false;
        function finish(result, httpStatus) {
            if (done) return;
            done = true;
            try { xhr.abort(); } catch (e) { /* ignore */ }
            cb(result || url, httpStatus || 0);
        }
        try {
            xhr.open('GET', url, true);
            xhr.onreadystatechange = function () {
                if (xhr.readyState >= 2) finish(xhr.status < 400 ? xhr.responseURL : url, xhr.status);
            };
            xhr.onerror = function () { finish(url); };
            xhr.send();
        } catch (e) {
            finish(url);
        }
        setTimeout(function () { finish(url); }, 8000);
    }

    function avplayPlay(url, token) {
        avplayStop();
        avEl.classList.add('active');
        placeElement(avEl, rect);
        status('Loading…');
        resolveRedirect(url, function (finalUrl, httpStatus) {
            if (token !== playToken) return;
            if (httpStatus >= 400) {
                // The provider already said no (e.g. 503 for an event channel that isn't live).
                fail('The channel is not available right now (provider replied ' + httpStatus + ').');
                return;
            }
            avplayOpen(finalUrl, token);
        });
    }

    function avplayOpen(url, token) {
        try {
            avplay.open(url);
            avplay.setListener({
                onbufferingstart: function () { if (token === playToken) status('Loading…'); },
                onbufferingprogress: function () {},
                onbufferingcomplete: function () { if (token === playToken) status(null); },
                onstreamcompleted: function () {
                    if (token === playToken) fail('The stream ended.');
                },
                onerror: function (type) {
                    if (token === playToken) fail(describeAvplayError(type));
                },
                oncurrentplaytime: function () {},
                onevent: function () {}
            });
            avplay.setDisplayRect(rect.x, rect.y, rect.w, rect.h);
            avplay.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
            // Live IPTV: start fast, keep a small buffer.
            try { avplay.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', 3); } catch (e) { /* older firmware */ }
            try { avplay.setBufferingParam('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', 5); } catch (e) { /* older firmware */ }
            status('Loading…');
            avplay.prepareAsync(function () {
                if (token !== playToken) return;
                try {
                    avplay.play();
                    status(null);
                } catch (e) {
                    fail('Could not start playback.');
                }
            }, function (err) {
                if (token === playToken) fail(describeAvplayError(err && (err.name || err.message)));
            });
        } catch (e) {
            fail(describeAvplayError(e && (e.name || e.message)));
        }
    }

    function describeAvplayError(type) {
        var t = String(type || '');
        if (/CONNECTION|NETWORK|TIMEOUT/i.test(t)) return 'Could not connect to the stream. Check your internet connection, or the channel may be offline.';
        if (/UNSUPPORTED|CODEC|FORMAT/i.test(t)) return 'This TV cannot play this channel\'s video format.';
        if (/INVALID_URI|NOT_FOUND|404/i.test(t)) return 'The channel is not available right now.';
        return 'Playback failed' + (t ? ' (' + t + ')' : '') + '. The channel may be offline.';
    }

    /* ---------------- <video> (browser, development) ---------------- */

    function htmlStop() {
        if (hls) { hls.destroy(); hls = null; }
        htmlEl.removeAttribute('src');
        try { htmlEl.load(); } catch (e) { /* ignore */ }
        htmlEl.classList.remove('active');
    }

    // play() rejects when interrupted by a channel change or pause; that's expected.
    function quietPlay() {
        var p = htmlEl.play();
        if (p && p.catch) p.catch(function () {});
    }

    function htmlPlay(url, token) {
        htmlStop();
        htmlEl.classList.add('active');
        placeElement(htmlEl, rect);
        // Browsers can't play raw MPEG-TS; Xtream panels serve the same channel as HLS.
        var src = global.Xtream.viaProxy(url.replace(/\.ts$/, '.m3u8'));
        htmlEl.onwaiting = function () { if (token === playToken) status('Loading…'); };
        htmlEl.onplaying = function () { if (token === playToken) status(null); };
        htmlEl.onerror = function () { if (token === playToken) fail('Playback failed. The channel may be offline.'); };
        status('Loading…');
        function start() {
            if (token !== playToken) return;
            var p = htmlEl.play();
            if (p && p.catch) {
                p.catch(function (err) {
                    // Autoplay blocked without a user gesture: retry muted.
                    if (err && err.name === 'NotAllowedError' && token === playToken) {
                        htmlEl.muted = true;
                        quietPlay();
                    }
                });
            }
        }
        if (global.Hls && global.Hls.isSupported()) {
            hls = new global.Hls({ lowLatencyMode: false });
            hls.on(global.Hls.Events.MANIFEST_PARSED, start);
            hls.on(global.Hls.Events.ERROR, function (e, data) {
                if (!data || !data.fatal || token !== playToken) return;
                var code = data.response && data.response.code;
                fail(code === 404 || code === 403 || /manifestLoad/.test(data.details)
                    ? 'The channel is not available right now.'
                    : 'Playback failed (' + data.details + '). The channel may be offline.');
            });
            hls.loadSource(src);
            hls.attachMedia(htmlEl);
        } else {
            htmlEl.src = src;
            start();
        }
    }

    /* ---------------- public ---------------- */

    var Player = {
        isTv: !!avplay,

        setListener: function (l) { listener = l; },

        play: function (url) {
            playToken++;
            currentUrl = url;
            armWatchdog(playToken);
            if (avplay) avplayPlay(url, playToken);
            else htmlPlay(url, playToken);
        },

        stop: function () {
            playToken++;
            clearTimeout(watchdog);
            currentUrl = null;
            if (avplay) { avplayStop(); avEl.classList.remove('active'); }
            else htmlStop();
            status(null);
        },

        isPlaying: function () { return currentUrl !== null; },

        /** Move/resize the picture: pass null for full screen. */
        setRect: function (r) {
            rect = r || FULL;
            if (avplay) {
                placeElement(avEl, rect);
                try { avplay.setDisplayRect(rect.x, rect.y, rect.w, rect.h); } catch (e) { /* not open */ }
            } else {
                placeElement(htmlEl, rect);
            }
        },

        /** App hidden (Home button / source change): release the decoder, resume later. */
        suspend: function () {
            if (!currentUrl) return;
            if (avplay) { try { avplay.suspend(); } catch (e) { avplayStop(); } }
            else htmlEl.pause();
        },

        resume: function () {
            if (!currentUrl) return;
            if (avplay) {
                try { avplay.restore(); }
                catch (e) { avplayPlay(currentUrl, ++playToken); }
            } else {
                quietPlay();
            }
        }
    };

    global.Player = Player;
})(window);
