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

    var START_TIMEOUT_MS = 12000;   // per attempt
    var MAX_RETRIES = 2;            // so up to 3 attempts in total (Settings: "Retry a channel")
    var RETRY_DELAY_MS = 2000;
    var BUFFER_PLAY_S = 4;          // seconds buffered before playback starts (Settings: "Buffering")
    var BUFFER_RESUME_S = 6;        // seconds buffered after a stall
    var HTML_BUFFER_S = 16;         // browser (dev) equivalent, for hls.js
    var watchdog = null;
    var retryTimer = null;
    var attempt = 0;
    var failedToken = -1;  // once a stream has failed, its late "Loading…" events must not hide the error
    var startedToken = -1; // the attempt whose picture has started moving

    function status(text) {
        if (failedToken === playToken) return;
        // Any "not loading" status means the picture is moving: stop the start-up watchdog.
        if (!text) { clearTimeout(watchdog); startedToken = playToken; }
        if (listener && listener.onStatus) listener.onStatus(text);
    }

    /*
     * The player is waiting for data. Before the picture first moves that's normal start-up
     * ("Loading…"); afterwards it's a stall in the middle of the programme ("Buffering…"),
     * which the app counts to suggest a bigger buffer.
     */
    function buffering(token) {
        if (token !== playToken) return;
        if (startedToken === token) {
            status('Buffering…');
            if (listener && listener.onStall) listener.onStall();
        } else {
            status('Loading…');
        }
    }

    /*
     * A failed attempt. Temporary problems (no connection, timeouts, server errors) are
     * retried a couple of times before the error is shown; `permanent` ones (channel refused
     * or missing, unsupported video) are shown straight away.
     */
    function fail(message, permanent) {
        clearTimeout(watchdog);
        if (failedToken === playToken) return;
        if (!permanent && attempt < MAX_RETRIES && currentUrl) {
            attempt++;
            failedToken = playToken;   // ignore the rest of this attempt's events
            if (listener && listener.onStatus) {
                listener.onStatus('Couldn\'t connect. Trying again (' + (attempt + 1) + ' of ' + (MAX_RETRIES + 1) + ')…');
            }
            var url = currentUrl;
            clearTimeout(retryTimer);
            retryTimer = setTimeout(function () { if (currentUrl === url) startAttempt(); }, RETRY_DELAY_MS);
            return;
        }
        failedToken = playToken;
        if (listener && listener.onError) {
            listener.onError(message + (attempt > 0 ? ' (tried ' + (attempt + 1) + ' times)' : ''));
        }
    }

    // Dead channels often never error out (endless retries inside the player); give up after a while.
    function armWatchdog(token) {
        clearTimeout(watchdog);
        watchdog = setTimeout(function () {
            if (token === playToken) fail('This channel isn\'t responding. It may be offline; try another channel.');
        }, START_TIMEOUT_MS);
    }

    function startAttempt() {
        playToken++;
        armWatchdog(playToken);
        if (avplay) avplayPlay(currentUrl, playToken);
        else htmlPlay(currentUrl, playToken);
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
                // The provider already said no. 4xx (refused, not found) won't change by retrying;
                // 5xx (e.g. 503 for an event channel that isn't live yet) might.
                fail('The channel is not available right now (provider replied ' + httpStatus + ').',
                    httpStatus < 500);
                return;
            }
            avplayOpen(finalUrl, token);
        });
    }

    function avplayOpen(url, token) {
        try {
            avplay.open(url);
            avplay.setListener({
                onbufferingstart: function () { buffering(token); },
                onbufferingprogress: function () {},
                onbufferingcomplete: function () { if (token === playToken) status(null); },
                onstreamcompleted: function () {
                    if (token === playToken) fail('The stream ended.');
                },
                onerror: function (type) {
                    if (token === playToken) fail(describeAvplayError(type), isPermanentAvplayError(type));
                },
                oncurrentplaytime: function () {},
                onevent: function () {}
            });
            avplay.setDisplayRect(rect.x, rect.y, rect.w, rect.h);
            avplay.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
            // Live IPTV: a small buffer starts fast; a bigger one rides out network hiccups.
            try { avplay.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', BUFFER_PLAY_S); } catch (e) { /* older firmware */ }
            try { avplay.setBufferingParam('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', BUFFER_RESUME_S); } catch (e) { /* older firmware */ }
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
                var type = err && (err.message || err.name);
                if (token === playToken) fail(describeAvplayError(type), isPermanentAvplayError(type));
            });
        } catch (e) {
            var type = e && (e.message || e.name);
            fail(describeAvplayError(type), isPermanentAvplayError(type));
        }
    }

    function isPermanentAvplayError(type) {
        return /UNSUPPORTED|CODEC|FORMAT|INVALID_URI|NOT_FOUND|404|403|DRM/i.test(String(type || ''));
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
        htmlEl.onwaiting = function () { buffering(token); };
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
            // No hls.js-internal playlist retries: retrying is done above (fail → startAttempt),
            // the same way as on the TV, so the browser behaves like the real thing.
            hls = new global.Hls({
                lowLatencyMode: false,
                maxBufferLength: HTML_BUFFER_S,
                manifestLoadPolicy: {
                    default: { maxTimeToFirstByteMs: 10000, maxLoadTimeMs: 20000, timeoutRetry: null, errorRetry: null }
                }
            });
            hls.on(global.Hls.Events.MANIFEST_PARSED, start);
            hls.on(global.Hls.Events.ERROR, function (e, data) {
                if (!data || !data.fatal || token !== playToken) return;
                var code = data.response && data.response.code;
                var missing = code === 404 || code === 403 || code === 401;
                fail(missing || /manifestLoad/.test(data.details)
                    ? 'The channel is not available right now.'
                    : 'Playback failed (' + data.details + '). The channel may be offline.', missing);
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

        /** Apply user settings; takes effect from the next channel started. */
        configure: function (opts) {
            if (opts.bufferPlay) BUFFER_PLAY_S = opts.bufferPlay;
            if (opts.bufferResume) BUFFER_RESUME_S = opts.bufferResume;
            if (opts.retries !== undefined) MAX_RETRIES = opts.retries;
            if (!avplay && opts.bufferPlay) HTML_BUFFER_S = Math.max(10, opts.bufferPlay * 4);
        },

        play: function (url) {
            clearTimeout(retryTimer);
            currentUrl = url;
            attempt = 0;
            startAttempt();
        },

        /** Try the current channel again from scratch (after its error was shown). */
        retry: function () {
            if (!currentUrl) return;
            clearTimeout(retryTimer);
            attempt = 0;
            startAttempt();
        },

        /** True when the current channel gave up and is showing an error. */
        hasFailed: function () { return !!currentUrl && failedToken === playToken; },

        stop: function () {
            playToken++;
            clearTimeout(watchdog);
            clearTimeout(retryTimer);
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
                catch (e) { attempt = 0; startAttempt(); }
            } else {
                quietPlay();
            }
        }
    };

    global.Player = Player;
})(window);
