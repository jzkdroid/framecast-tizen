/* Remote control keys -> action names. Keyboard equivalents make desktop testing possible. */
(function (global) {
    'use strict';

    var TV_KEYS = [
        'ChannelUp', 'ChannelDown', 'Info',
        'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue',
        'MediaPlayPause', 'MediaPlay', 'MediaStop',
        '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'
    ];

    var CODES = {
        37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'ok',
        10009: 'back', 27: 'back', 8: 'back',          // Return / Esc / Backspace
        427: 'chup', 428: 'chdown', 33: 'chup', 34: 'chdown',   // CH+/- or PageUp/PageDown
        457: 'info',
        403: 'red', 404: 'green', 405: 'yellow', 406: 'blue',
        10252: 'playpause', 415: 'play', 413: 'stop',
        65376: 'imedone', 65385: 'imecancel'           // on-screen keyboard Done / Cancel
    };

    // Desktop shortcuts for the colour buttons and Info (only when not typing).
    var LETTERS = { r: 'red', g: 'green', y: 'yellow', b: 'blue', i: 'info' };

    function register() {
        var tvid = global.tizen && global.tizen.tvinputdevice;
        if (!tvid) return;
        try {
            if (tvid.registerKeyBatch) {
                var supported = tvid.getSupportedKeys().map(function (k) { return k.name; });
                tvid.registerKeyBatch(TV_KEYS.filter(function (k) { return supported.indexOf(k) !== -1; }));
            } else {
                TV_KEYS.forEach(function (k) { try { tvid.registerKey(k); } catch (e) { /* unsupported */ } });
            }
        } catch (e) { /* keys stay unregistered; arrows/OK/Back still work */ }
    }

    /** Returns an action name, a digit string '0'-'9', or null. */
    function actionFor(e, typing) {
        var code = e.keyCode;
        if (code >= 48 && code <= 57 && !typing) return String(code - 48);
        if (code >= 96 && code <= 105 && !typing) return String(code - 96);   // numpad
        if (typing && (code === 8 || code === 37 || code === 39)) return null;  // let the input edit text
        var a = CODES[code];
        if (a) return a;
        if (!typing && e.key && LETTERS[e.key.toLowerCase()]) return LETTERS[e.key.toLowerCase()];
        return null;
    }

    function exitApp() {
        try { global.tizen.application.getCurrentApplication().exit(); }
        catch (e) { global.close(); }
    }

    global.Keys = { register: register, actionFor: actionFor, exitApp: exitApp };
})(window);
