/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Some parts of this file are derived from:
 * Chameleon <https://github.com/ghostwords/chameleon>, Copyright (C) 2015 ghostwords
 * Privacy Badger Chrome <https://github.com/EFForg/privacybadger>, Copyright (C) 2015 Electronic Frontier Foundation and other contributors
 */

if (true || chrome.contentSettings.canvasFingerprinting == 'block') {
  Error.stackTraceLimit = Infinity // collect all frames

  // https://code.google.com/p/v8-wiki/wiki/JavaScriptStackTraceApi
  /**
   * Customize the stack trace
   * @param structured If true, change to customized version
   * @returns {*} Returns the stack trace
   */
  function getStackTrace (structured) {
    var errObj = {}
    var origFormatter
    var stack

    if (structured) {
      origFormatter = Error.prepareStackTrace
      Error.prepareStackTrace = function (errObj, structuredStackTrace) {
        return structuredStackTrace
      }
    }

    Error.captureStackTrace(errObj, getStackTrace)
    stack = errObj.stack

    if (structured) {
      Error.prepareStackTrace = origFormatter
    }

    return stack
  }

  /**
   * Checks the stack trace for the originating URL
   * @returns {String} The URL of the originating script (URL:Line number:Column number)
   */
  function getOriginatingScriptUrl () {
    var trace = getStackTrace(true)

    if (trace.length < 3) {
      return ''
    }

    // this script is at 0 and 1
    var callSite = trace[2]

    if (callSite.isEval()) {
      // argh, getEvalOrigin returns a string ...
      var eval_origin = callSite.getEvalOrigin()
      var script_url_matches = eval_origin.match(/\((http.*:\d+:\d+)/)

      return script_url_matches && script_url_matches[1] || eval_origin
    } else {
      return callSite.getFileName() + ':' + callSite.getLineNumber() + ':' + callSite.getColumnNumber()
    }
  }

  /**
   *  Strip away the line and column number (from stack trace urls)
   * @param script_url The stack trace url to strip
   * @returns {String} the pure URL
   */
  function stripLineAndColumnNumbers (script_url) {
    return script_url.replace(/:\d+:\d+$/, '')
  }

  // To avoid throwing hard errors on code that expects a fingerprinting feature
  // to be in place, create a method that can be called as if it were most
  // other types of objects (ie can be called like a function, can be indexed
  // into like an array, can have properties looked up, etc).
  //
  // This is done in two steps.  First, create a default, no-op function
  // (`defaultFunc` below), and then second, wrap it in a Proxy that traps
  // on all these operations, and yields itself.  This allows for long
  // chains of no-op operations like
  //    AnalyserNode.prototype.getFloatFrequencyData().bort.alsoBort,
  // even though AnalyserNode.prototype.getFloatFrequencyData has been replaced.
  var defaultFunc = function () {}

  // In order to avoid deeply borking things, we need to make sure we don't
  // prevent access to builtin object properties and functions (things
  // like (Object.prototype.constructor).  So, build a list of those below,
  // and then special case those in the allPurposeProxy object's traps.
  var funcPropNames = Object.getOwnPropertyNames(defaultFunc)
  var unconfigurablePropNames = funcPropNames.filter(function (propName) {
    var possiblePropDesc = Object.getOwnPropertyDescriptor(defaultFunc, propName)
    return (possiblePropDesc && !possiblePropDesc.configurable)
  })

  var valueOfCoercionFunc = function (hint) {
    if (hint === 'string') {
      return ''
    }
    if (hint === 'number' || hint === 'default') {
      return 0
    }
    return undefined
  }

  var allPurposeProxy = new Proxy(defaultFunc, {
    get: function (target, property) {

      if (property === Symbol.toPrimitive) {
        return valueOfCoercionFunc
      }

      if (property === 'toString') {
        return ''
      }

      if (property === 'valueOf') {
        return 0
      }

      return allPurposeProxy
    },
    set: function () {
      return allPurposeProxy
    },
    apply: function () {
      return allPurposeProxy
    },
    ownKeys: function () {
      return unconfigurablePropNames
    },
    has: function (target, property) {
      return (unconfigurablePropNames.indexOf(property) > -1)
    },
    getOwnPropertyDescriptor: function (target, property) {
      if (unconfigurablePropNames.indexOf(property) === -1) {
        return undefined
      }
      return Object.getOwnPropertyDescriptor(defaultFunc, property)
    }
  })

  function reportBlock (type) {
    var script_url = getOriginatingScriptUrl()
    if (script_url) {
      script_url = stripLineAndColumnNumbers(script_url)
    } else {
      script_url = window.location.href
    }
    var msg = {
      type,
      scriptUrl: stripLineAndColumnNumbers(script_url)
    }

    // Block the read from occuring; send info to background page instead
    chrome.ipcRenderer.sendToHost('got-canvas-fingerprinting', msg)

    return allPurposeProxy
  }

  /**
   * Monitor the reads from a canvas instance
   * @param item special item objects
   */
  function trapInstanceMethod (item) {
    if (!item.methodName) {
      chrome.webFrame.setGlobal(item.objName + ".prototype." + item.propName, reportBlock.bind(null, item.type))
    } else {
      chrome.webFrame.setGlobal(item.methodName, reportBlock.bind(null, item.type))
    }
  }

  function overrideProperty (val) {
      console.log("overrideProperty returning " + val);
      chrome.ipcRenderer.sendToHost('got-canvas-fingerprinting', 'overrideProperty returning ' + val);
      return allPurposeProxy;
  }

  /**
   * Force a screen.foo or window.bar property to have a specific value.
   * @param objName name of the object on which the property resides, such as "screen"
   * @param itemName attribute name of the targeted property, such as "width"
   * @param value simple value that should be returned, such as 1439.
   */
  function overrideWindowProperty (objName, itemName, value) {
      chrome.webFrame.setGlobal(objName + ".prototype." + itemName, overrideProperty.bind(null, value));
  }

  var methods = []
  var canvasMethods = ['getImageData', 'getLineDash', 'measureText']
  canvasMethods.forEach(function (method) {
    var item = {
      type: 'Canvas',
      objName: 'CanvasRenderingContext2D',
      propName: method
    }

    methods.push(item)
  })

  var canvasElementMethods = ['toDataURL', 'toBlob']
  canvasElementMethods.forEach(function (method) {
    var item = {
      type: 'Canvas',
      objName: 'HTMLCanvasElement',
      propName: method
    }
    methods.push(item)
  })

  var webglMethods = ['getSupportedExtensions', 'getParameter', 'getContextAttributes',
    'getShaderPrecisionFormat', 'getExtension', 'readPixels']
  webglMethods.forEach(function (method) {
    var item = {
      type: 'WebGL',
      objName: 'WebGLRenderingContext',
      propName: method
    }
    methods.push(item)
    methods.push(Object.assign({}, item, {objName: 'WebGL2RenderingContext'}))
  })

  var audioBufferMethods = ['copyFromChannel', 'getChannelData']
  audioBufferMethods.forEach(function (method) {
    var item = {
      type: 'AudioContext',
      objName: 'AudioBuffer',
      propName: method
    }
    methods.push(item)
  })

  var analyserMethods = ['getFloatFrequencyData', 'getByteFrequencyData',
    'getFloatTimeDomainData', 'getByteTimeDomainData']
  analyserMethods.forEach(function (method) {
    var item = {
      type: 'AudioContext',
      objName: 'AnalyserNode',
      propName: method
    }
    methods.push(item)
  })

  // Based on https://github.com/webrtcHacks/webrtcnotify
  var webrtcMethods = ['createOffer', 'createAnswer', 'setLocalDescription', 'setRemoteDescription']
  webrtcMethods.forEach(function (method) {
    var item = {
      type: 'WebRTC',
      objName: 'webkitRTCPeerConnection',
      propName: method
    }
    methods.push(item)
  })

  methods.forEach(trapInstanceMethod)

  // Block WebRTC device enumeration
  trapInstanceMethod({
    type: 'WebRTC',
    methodName: 'navigator.mediaDevices.enumerateDevices'
  })

  class Random {
      constructor () {
          this.vals = new Uint32Array(10);
          this.idx = 0;
          window.crypto.getRandomValues(this.vals);
      }

      // start this Random creator over at the beginning of its sequence.
      // This is intended to be used like so:
      // var r = new Random();
      // var a = r.randint(10);
      // var b = r.randint(10);
      // r.reset();
      // assert(r.randint(10) == a);
      // assert(r.randint(10) == b);
      reset() {
          this.idx = 0;
      }

      // Expand the vals array to have n entries.
      // internal helper function only.
      expand(n) {
          if (n < this.vals.length) {
              return;
          }
          var nnew = n - this.vals.length;
          var newvals = new Uint32Array(nnew);
          window.crypto.getRandomValues(newvals);
          var v = new Uint32Array(n);
          for (var i = 0; i < nnew; i++) {
              v[n + i] = newvals[i];
          }
          this.vals = v;
      }

      // Primary interface for users.  Returns a random value in the range
      // [0 .. limit - 1].
      randint(limit) {
          // XXX this is biased by the modulo
          var i = this.idx++;
          if (i > this.vals.length) {
              this.reseed(2 * i);
          }
          return this.vals[i] % limit;
      }
  }

  // Normalize and then randomize the screen dimensions
  function randomizeScreen () {
      prng = new Random();
      dA = prng.randint(64);
      dB = prng.randint(64);
      dC = prng.randint(64);
      dD = prng.randint(64);
      console.log("randomizeScreen a=" + dA + " b=" + dB + " c=" + dC + " d=" + dD);
      overrideWindowProperty('Screen', 'width', screen.width - dA);
      overrideWindowProperty('Screen', 'height', screen.height - dB);
      overrideWindowProperty('Screen', 'availWidth', screen.availWidth - dC);
      overrideWindowProperty('Screen', 'height', screen.availHeight - dD);
  }

  randomizeScreen();

}
