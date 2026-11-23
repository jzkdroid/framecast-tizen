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

    /*
     * BigStore: IndexedDB for data too large for localStorage (~5 MB), such as the saved channel
     * list. Every call resolves (never rejects): failures read as null, so a missing or broken
     * database just means "nothing saved".
     */
    var DB_NAME = 'framecast', STORE = 'kv';
    var dbPromise = null;

    function openDb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise(function (resolve) {
            var idb = global.indexedDB;
            if (!idb) { resolve(null); return; }
            var done = false;
            function finish(db) { if (!done) { done = true; resolve(db); } }
            try {
                var req = idb.open(DB_NAME, 1);
                req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
                req.onsuccess = function () { finish(req.result); };
                req.onerror = function () { finish(null); };
                req.onblocked = function () { finish(null); };
            } catch (e) { finish(null); }
            setTimeout(function () { finish(null); }, 3000);   // never hold up startup
        });
        return dbPromise;
    }

    function request(mode, fn) {
        return openDb().then(function (db) {
            if (!db) return null;
            return new Promise(function (resolve) {
                try {
                    var tx = db.transaction(STORE, mode);
                    var req = fn(tx.objectStore(STORE));
                    tx.oncomplete = function () { resolve(req && req.result !== undefined ? req.result : null); };
                    tx.onerror = tx.onabort = function () { resolve(null); };
                } catch (e) { resolve(null); }
            });
        });
    }

    global.BigStore = {
        get: function (key) { return request('readonly', function (s) { return s.get(PREFIX + key); }); },
        put: function (key, value) { return request('readwrite', function (s) { return s.put(value, PREFIX + key); }); },
        remove: function (key) { return request('readwrite', function (s) { return s.delete(PREFIX + key); }); }
    };
})(window);
