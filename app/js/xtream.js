/* Xtream Codes API client (player_api.php). Runs directly on the TV. */
(function (global) {
    'use strict';

    // On the TV the widget's <access origin="*"> allows cross-origin requests.
    // In a desktop browser during development, requests go through the dev server's proxy.
    var DEV_PROXY = (!global.webapis && /^(localhost|127\.0\.0\.1)$/.test(global.location.hostname))
        ? '/proxy?url=' : '';

    function viaProxy(url) {
        if (!DEV_PROXY) return url;
        // Same-origin URLs (the mock provider) need no proxy.
        if (url.indexOf(global.location.origin + '/') === 0) return url;
        return DEV_PROXY + encodeURIComponent(url);
    }

    function getJson(url, timeoutMs) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', viaProxy(url), true);
            xhr.timeout = timeoutMs || 60000;
            xhr.onload = function () {
                if (xhr.status < 200 || xhr.status >= 300) {
                    // 4xx won't fix itself by retrying (wrong URL, blocked account); 5xx might.
                    reject(permanentIf(new Error('Server replied ' + xhr.status), xhr.status >= 400 && xhr.status < 500));
                    return;
                }
                try {
                    resolve(JSON.parse(xhr.responseText));
                } catch (e) {
                    reject(new Error('The server did not return valid data'));
                }
            };
            xhr.onerror = function () { reject(new Error('Could not reach the server')); };
            xhr.ontimeout = function () { reject(new Error('The server took too long to answer')); };
            xhr.send();
        });
    }

    /** Marks errors that retrying can't fix, so callers don't retry them. */
    function permanentIf(err, yes) {
        if (yes) err.permanent = true;
        return err;
    }

    function normalizeServer(server) {
        var s = String(server || '').trim();
        if (!s) return '';
        if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
        s = s.replace(/\/+$/, '');
        // People often paste the full API or panel URL.
        s = s.replace(/\/(player_api|get|panel_api|xmltv)\.php.*$/i, '');
        return s;
    }

    function decodeBase64(text) {
        if (!text) return '';
        try {
            return decodeURIComponent(escape(global.atob(text)));
        } catch (e) {
            try { return global.atob(text); } catch (e2) { return String(text); }
        }
    }

    function Xtream(server, username, password) {
        this.server = normalizeServer(server);
        this.username = String(username || '').trim();
        this.password = String(password || '');
        this.outputFormat = 'ts';
    }

    Xtream.prototype.apiUrl = function (action, params) {
        var url = this.server + '/player_api.php?username=' + encodeURIComponent(this.username) +
            '&password=' + encodeURIComponent(this.password);
        if (action) url += '&action=' + encodeURIComponent(action);
        if (params) {
            Object.keys(params).forEach(function (k) {
                if (params[k] !== undefined && params[k] !== null) {
                    url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
                }
            });
        }
        return url;
    };

    Xtream.prototype.call = function (action, params, timeoutMs) {
        return getJson(this.apiUrl(action, params), timeoutMs);
    };

    /** Resolves with the account info, or rejects with a readable message. */
    Xtream.prototype.login = function () {
        var self = this;
        if (!self.server) return Promise.reject(permanentIf(new Error('Enter your server URL'), true));
        if (!self.username) return Promise.reject(permanentIf(new Error('Enter your username'), true));
        return self.call(null, null, 20000).then(function (data) {
            var info = data && data.user_info;
            if (!info || String(info.auth) !== '1') {
                throw permanentIf(new Error('Wrong username or password'), true);
            }
            if (info.status && info.status !== 'Active') {
                throw permanentIf(new Error('Account status: ' + info.status), true);
            }
            var formats = info.allowed_output_formats || [];
            // Prefer HLS: on Tizen 10 AVPlay failed to connect to redirected MPEG-TS streams
            // (PLAYER_ERROR_CONNECTION_FAILED) but played the same channel's HLS playlist.
            self.outputFormat = !formats.length || formats.indexOf('m3u8') !== -1 ? 'm3u8'
                : (formats.indexOf('ts') !== -1 ? 'ts' : formats[0]);
            return info;
        });
    };

    Xtream.prototype.liveCategories = function () {
        return this.call('get_live_categories').then(function (list) {
            return (Array.isArray(list) ? list : []).map(function (c) {
                return { id: String(c.category_id), name: String(c.category_name || 'Untitled') };
            });
        });
    };

    Xtream.prototype.liveStreams = function () {
        return this.call('get_live_streams', null, 120000).then(function (list) {
            return (Array.isArray(list) ? list : []).map(function (s, i) {
                return {
                    id: String(s.stream_id),
                    num: parseInt(s.num, 10) || (i + 1),
                    name: String(s.name || 'Channel ' + (i + 1)).trim(),
                    logo: s.stream_icon || '',
                    cat: String(s.category_id),
                    epgId: s.epg_channel_id || ''
                };
            });
        });
    };

    /** Now/next listings for one channel: [{title, start, end}] in ms, sorted. */
    Xtream.prototype.shortEpg = function (streamId, limit) {
        return this.call('get_short_epg', { stream_id: streamId, limit: limit || 6 }, 15000)
            .then(function (data) {
                var rows = (data && data.epg_listings) || [];
                return rows.map(function (r) {
                    var start = parseInt(r.start_timestamp, 10) * 1000;
                    var end = parseInt(r.stop_timestamp, 10) * 1000;
                    return {
                        title: decodeBase64(r.title) || 'Untitled',
                        start: start,
                        end: end
                    };
                }).filter(function (r) {
                    return r.start && r.end && r.end > Date.now() - 60000;
                }).sort(function (a, b) { return a.start - b.start; });
            });
    };

    Xtream.prototype.streamUrl = function (streamId) {
        var ext = this.outputFormat === 'm3u8' ? 'm3u8' : 'ts';
        return this.server + '/live/' + encodeURIComponent(this.username) + '/' +
            encodeURIComponent(this.password) + '/' + streamId + '.' + ext;
    };

    Xtream.viaProxy = viaProxy;
    Xtream.normalizeServer = normalizeServer;
    global.Xtream = Xtream;
})(window);
