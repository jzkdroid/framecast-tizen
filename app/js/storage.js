/* Small localStorage wrapper. Storage can be unavailable or full; never let that break the app. */
(function (global) {
    'use strict';

    var PREFIX = 'framecast.';

    function read(key, fallback) {
        try {
            var raw = global.localStorage.getItem(PREFIX + key);
            return raw === null ? fallback : JSON.parse(raw);
        } catch (e) {
            return fallback;
        }
    }

    function write(key, value) {
        try {
            global.localStorage.setItem(PREFIX + key, JSON.stringify(value));
        } catch (e) { /* ignore */ }
    }

    function remove(key) {
        try {
            global.localStorage.removeItem(PREFIX + key);
        } catch (e) { /* ignore */ }
    }

    global.Store = { read: read, write: write, remove: remove };
})(window);
