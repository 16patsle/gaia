/* -*- Mode: js; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- /
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */

/**
 * @fileoverview Keyboard Overview.
 *
 * **keyboard.js**:
 *
 * This is the main module of the Gaia keyboard app. It does these things:
 *
 * - Hides and shows the keyboard in response to focuschange events from
 *   navigator.mozInputMethod.inputcontext
 *
 * - Loads the input method (from imes/) module required by a keyboard
 *
 * - Handles settings changes for the user's language, keyboard layouts, and
 *   preferences for word suggestions, and updates the keyboard accordingly.
 *
 * - Handles resize events (caused by orientation changes) and updates
 *   the keyboard accordingly.
 *
 * - Handles (using code that was formerly in a separate controller.js module)
 *   mouse events over the keyboard and passes them to the input method.
 *
 * - When the input method sends value back to the keyboard, it turns
 *   them into synthetic key events using the inputmethod API.
 *
 * This module includes code that was formerly in the controller.js and
 * feedback.js modules. Other modules handle other parts of the keyboard:
 *
 *  * **layout.js**: defines data structures that represent keyboard layouts
 *  * **render.js**: creates the on-screen keyboard with HTML and CSS
 *
 */

'use strict';

// A timer for time measurement
// XXX: render.js is using this variable from other script.
var perfTimer = new PerformanceTimer();
perfTimer.start();
perfTimer.printTime('keyboard.js');

var isWaitingForSecondTap = false;
var alternativesMenuTouchId = undefined;
var isShowingAlternativesMenu = false;
var isContinousSpacePressed = false;
var isUpperCase = false;
var isUpperCaseLocked = false;
// activeTargets keeps the active elements in the view of highlight indication
// and alternative menu, and actual key to commit when touch event ends.
// It is not necessary the element the finger is currently under.
var activeTargets = new Map();
var menuLockedArea = null;
var isKeyboardRendered = false;
var currentCandidates = [];
var candidatePanelScrollTimer = null;

// Show accent char menu (if there is one) after ACCENT_CHAR_MENU_TIMEOUT
const ACCENT_CHAR_MENU_TIMEOUT = 700;

// Backspace repeat delay and repeat rate
const REPEAT_RATE = 75;
const REPEAT_TIMEOUT = 700;

// How long to wait for more focuschange events before processing
const FOCUS_CHANGE_DELAY = 100;

// Taps the shift key twice within CAPS_LOCK_TIMEOUT
// to lock the keyboard at upper case state.
const CAPS_LOCK_TIMEOUT = 450;

// Time we wait after blur to hide the keyboard
// in case we get a focus event right after
const HIDE_KEYBOARD_TIMEOUT = 500;

// timeout and interval for delete, they could be cancelled on mouse over
var deleteTimeout = 0;
var deleteInterval = 0;
var menuTimeout = 0;
var hideKeyboardTimeout = 0;

const specialCodes = [
  KeyEvent.DOM_VK_BACK_SPACE,
  KeyEvent.DOM_VK_CAPS_LOCK,
  KeyEvent.DOM_VK_RETURN,
  KeyEvent.DOM_VK_ALT,
  KeyEvent.DOM_VK_SPACE
];

// XXX: For now let's pass a fake app object,
// in the future this should be wired to a KeyboardApp instance.
var fakeAppObject = {
  inputMethodManager: null,
  layoutManager: null,
  settingsPromiseManager: null,
  l10nLoader: null,
  userPressManager: null,

  inputContext: null,

  getContainer: function() {
    // This is equal to IMERender.ime.
    return document.getElementById('keyboard');
  },

  getBasicInputType: function() {
    if (!this.inputContext) {
      return 'text';
    }

    var type = this.inputContext.inputType;
    switch (type) {
      // basic types
      case 'url':
      case 'tel':
      case 'email':
      case 'text':
        return type;

        break;

      // default fallback and textual types
      case 'password':
      case 'search':
      default:
        return 'text';

        break;

      case 'number':
      case 'range': // XXX: should be different from number
        return 'number';

        break;
    }
  },

  supportsSwitching: function() {
    return navigator.mozInputMethod.mgmt.supportsSwitching();
  },

  sendCandidates: function kc_glue_sendCandidates(candidates) {
    perfTimer.printTime('glue.sendCandidates');
    currentCandidates = candidates;
    IMERender.showCandidates(candidates);
  },
  setComposition: function kc_glue_setComposition(symbols, cursor) {
    perfTimer.printTime('glue.setComposition');
    cursor = cursor || symbols.length;
    this.inputContext.setComposition(symbols, cursor);
  },
  endComposition: function kc_glue_endComposition(text) {
    perfTimer.printTime('glue.endComposition');
    text = text || '';
    this.inputContext.endComposition(text);
  },
  sendKey: sendKey,
  setForcedModifiedLayout: function(layoutName) {
    layoutManager.updateForcedModifiedLayout(layoutName);
    renderKeyboard();
  },
  setLayoutPage: function setLayoutPage(page) {
    if (page === this.layoutManager.currentLayoutPage) {
      return;
    }

    this.layoutManager.updateLayoutPage(page);
    renderKeyboard();

    if (inputMethodManager.currentIMEngine.setLayoutPage) {
      inputMethodManager.currentIMEngine.
        setLayoutPage(layoutManager.currentLayoutPage);
    }
  },
  setUpperCase: setUpperCase,
  resetUpperCase: resetUpperCase,
  isCapitalized: isCapitalized,
  replaceSurroundingText: replaceSurroundingText,
  getNumberOfCandidatesPerRow:
    IMERender.getNumberOfCandidatesPerRow.bind(IMERender)
};

// InputMethodManager is responsible of loading/activating input methods.
var inputMethodManager =
  fakeAppObject.inputMethodManager = new InputMethodManager(fakeAppObject);
inputMethodManager.start();

// LayoutManager loads and holds layout layouts for us.
// It also help us ensure there is only one current layout at the time.
var layoutManager =
  fakeAppObject.layoutManager = new LayoutManager(fakeAppObject);
layoutManager.start();
var layoutLoader = layoutManager.loader;

// SettingsPromiseManager wraps Settings DB methods into promises.
var settingsPromiseManager =
  fakeAppObject.settingsPromiseManager = new SettingsPromiseManager();

// L10nLoader loads l10n.js. We call it's one and only load() method
// only after we have run everything in the critical cold launch path.
var l10nLoader = fakeAppObject.l10nLoader = new L10nLoader();

// UserPressManager handle and respond to touch/mouse events
var userPressManager =
  fakeAppObject.userPressManager = new UserPressManager(fakeAppObject);
userPressManager.onpressstart = startPress;
userPressManager.onpressmove = movePress;
userPressManager.onpressend = endPress;
userPressManager.start();

// User settings (in Settings database) are tracked within these modules
var soundFeedbackSettings;
var vibrationFeedbackSettings;
var imEngineSettings;

// We keep this promise in the global scope for the time being,
// so they can be called as soon as we need it to.
var inputContextGetTextPromise;

// data URL for keyboard click sound
const CLICK_SOUND = './resources/sounds/key.ogg';
const SPECIAL_SOUND = './resources/sounds/special.ogg';

// The audio element used to play the click sound
var clicker;
var specialClicker;

// A MutationObserver we use to spy on the renderer module
var dimensionsObserver;

// For tracking "scrolling the full candidate panel".
var touchStartCoordinate;

initKeyboard();

// We cannot listen to resize event right at start because of
// https://bugzil.la/1007595 ;
// only attach the event listener after 600ms.
setTimeout(function attachResizeListener() {
  perfTimer.printTime('attachResizeListener');
  // Handle resize events
  window.addEventListener('resize', onResize);
}, 2000);

function initKeyboard() {
  perfTimer.startTimer('initKeyboard');
  perfTimer.printTime('initKeyboard');
  // Getting initial settings values asynchronously,
  // Plus monitor the value when it changes.
  soundFeedbackSettings = new SoundFeedbackSettings();
  soundFeedbackSettings.promiseManager = settingsPromiseManager;
  soundFeedbackSettings.onsettingchange = handleKeyboardSound;
  soundFeedbackSettings.initSettings().then(
    handleKeyboardSound,
    function rejected() {
      console.warn('Failed to get initial sound settings.');
    });

  vibrationFeedbackSettings = new VibrationFeedbackSettings();
  vibrationFeedbackSettings.promiseManager = settingsPromiseManager;
  var vibrationInitPromise = vibrationFeedbackSettings.initSettings();
  vibrationInitPromise.catch(function rejected() {
    console.warn('Failed to get initial vibration settings.');
  });

  imEngineSettings = new IMEngineSettings();
  imEngineSettings.promiseManager = settingsPromiseManager;
  var imEngineSettingsInitPromise = imEngineSettings.initSettings();
  imEngineSettingsInitPromise.catch(function rejected() {
    console.error('Fatal Error! Failed to get initial imEngine settings.');
  });

  // Initialize the rendering module
  IMERender.init(getUpperCaseValue, isSpecialKeyObj);

  dimensionsObserver = new MutationObserver(function() {
    perfTimer.printTime('dimensionsObserver:callback');
    updateTargetWindowHeight();
  });

  // And observe mutation events on the renderer element
  dimensionsObserver.observe(IMERender.ime, {
    childList: true, // to detect changes in IMEngine
    attributes: true, attributeFilter: ['class', 'style']
  });

  window.addEventListener('hashchange', function() {
    perfTimer.printTime('hashchange');
    var layoutName = window.location.hash.substring(1);

    if (fakeAppObject.inputContext && !inputContextGetTextPromise) {
      inputContextGetTextPromise = fakeAppObject.inputContext.getText();
    }

    layoutLoader.getLayoutAsync(layoutName);
    updateCurrentLayout(layoutName);
  }, false);

  // Need to listen to both mozvisibilitychange and oninputcontextchange,
  // because we are not sure which will happen first and we will call
  // showKeyboard() when mozHidden is false and we got inputContext
  window.addEventListener('mozvisibilitychange', function visibilityHandler() {
    perfTimer.printTime('mozvisibilitychange');
    if (document.mozHidden && !fakeAppObject.inputContext) {
      hideKeyboard();

      return;
    }

    var layoutName = window.location.hash.substring(1);
    updateCurrentLayout(layoutName);
  });

  window.navigator.mozInputMethod.oninputcontextchange = function() {
    perfTimer.printTime('inputcontextchange');
    fakeAppObject.inputContext = navigator.mozInputMethod.inputcontext;
    if (fakeAppObject.inputContext && !inputContextGetTextPromise) {
      inputContextGetTextPromise = fakeAppObject.inputContext.getText();
    }
    if (document.mozHidden && !fakeAppObject.inputContext) {
      hideKeyboard();

      return;
    }

    var layoutName = window.location.hash.substring(1);
    updateCurrentLayout(layoutName);
  };

  // Initialize the current layout according to
  // the hash this page is loaded with.
  var layoutName = '';
  if (window.location.hash !== '') {
    layoutName = window.location.hash.substring(1);
    layoutLoader.getLayoutAsync(layoutName);
  } else {
    console.error('This page should never be loaded without an URL hash.');

    return;
  }

  // fill inputContextGetTextPromise and fakeAppObject.inputContext
  fakeAppObject.inputContext = navigator.mozInputMethod.inputcontext;
  if (fakeAppObject.inputContext) {
    inputContextGetTextPromise = fakeAppObject.inputContext.getText();
  }

  // Finally, if we are only loaded by keyboard manager when the user
  // have already focused, the keyboard should show right away.
  updateCurrentLayout(layoutName);
}

function handleKeyboardSound(settings) {
  if (settings.clickEnabled &&
      !!settings.isSoundEnabled) {
    clicker = new Audio(CLICK_SOUND);
    specialClicker = new Audio(SPECIAL_SOUND);
  } else {
    clicker = null;
    specialClicker = null;
  }
}

function deactivateInputMethod() {
  // Switching to default IMEngine makes the current IMEngine deactivate.
  // The currentIMEngine will be set and activates again in
  // showKeyboard() (specifically, switchIMEngine()).
  inputMethodManager.switchCurrentIMEngine('default');
}

function updateCurrentLayout(name) {
  perfTimer.printTime('updateCurrentLayout');

  layoutManager.switchCurrentLayout(name).then(function() {
    perfTimer.printTime('updateCurrentLayout:promise resolved');

    // Ask the loader to start loading IMEngine
    var imEngineloader = inputMethodManager.loader;
    var imEngineName = keyboard.imEngine;
    if (imEngineName && !imEngineloader.getInputMethod(imEngineName)) {
      imEngineloader.getInputMethodAsync(imEngineName);
    }

    // Now the that we have the layout ready,
    // we should either show or hide the keyboard.
    if (!document.mozHidden && fakeAppObject.inputContext) {
      showKeyboard();
    } else {
      hideKeyboard();

      // Load l10n library here, there is nothing more to do left
      // in the critical path.
      l10nLoader.load();
    }
  }, function(error) {
    console.warn('Failed to switch layout for ' + name + '.' +
      ' It might possible because we were called more than once.');
  });
}

// Support function for render
function isSpecialKeyObj(key) {
  var hasSpecialCode = key.keyCode !== KeyEvent.DOM_VK_SPACE &&
    key.keyCode &&
    specialCodes.indexOf(key.keyCode) !== -1;
  return hasSpecialCode || key.keyCode <= 0;
}

// This function asks render.js to create an HTML layout for the keyboard.
// The layout is based on the layout in layout.js, but is augmented by
// modifyLayout() to include keyboard-switching keys and type-specific keys
// for url and email address input, e.g.
//
// This should be called when the keyboard changes or when the layout page
// changes in order to actually render the layout.
//
function renderKeyboard() {
  perfTimer.printTime('renderKeyboard');
  perfTimer.startTimer('renderKeyboard');

  IMERender.ime.classList.remove('full-candidate-panel');

  // Rule of thumb: always render uppercase, unless secondLayout has been
  // specified (for e.g. arabic, then depending on shift key)
  var needsUpperCase = layoutManager.currentModifiedLayout.secondLayout ?
    (isUpperCaseLocked || isUpperCase) : true;

  // And draw the layout
  IMERender.draw(layoutManager.currentModifiedLayout, {
    uppercase: needsUpperCase,
    inputType: fakeAppObject.getBasicInputType(),
    showCandidatePanel: needsCandidatePanel()
  }, function() {
    perfTimer.printTime('IMERender.draw:callback');
    perfTimer.startTimer('IMERender.draw:callback');
    // So there are a couple of things that we want don't want to block
    // on here, so we can do it if resizeUI is fully finished
    IMERender.setUpperCaseLock(isUpperCaseLocked ? 'locked' : isUpperCase);

    // Tell the input method about the new keyboard layout
    updateLayoutParams();

    IMERender.showCandidates(currentCandidates);
    perfTimer.printTime(
      'BLOCKING IMERender.draw:callback', 'IMERender.draw:callback');
  });

  // Tell the renderer what input method we're using. This will set a CSS
  // classname that can be used to style the keyboards differently
  IMERender.setInputMethodName(
    layoutManager.currentModifiedLayout.imEngine || 'default');

  // If needed, empty the candidate panel
  if (inputMethodManager.currentIMEngine.empty) {
    inputMethodManager.currentIMEngine.empty();
  }

  isKeyboardRendered = true;

  perfTimer.printTime('BLOCKING renderKeyboard', 'renderKeyboard');
}

function setUpperCase(upperCase, upperCaseLocked) {
  upperCaseLocked = (typeof upperCaseLocked == 'undefined') ?
                     isUpperCaseLocked : upperCaseLocked;

  // Do nothing if the states are not changed
  if (isUpperCase == upperCase &&
      isUpperCaseLocked == upperCaseLocked)
    return;

  isUpperCaseLocked = upperCaseLocked;
  isUpperCase = upperCase;

  if (!isKeyboardRendered)
    return;

  // When we have secondLayout, we need to force re-render on uppercase switch
  if (layoutManager.currentModifiedLayout.secondLayout) {
    return renderKeyboard();
  }

  // Otherwise we can just update only the keys we need...
  // Try to block the event loop as little as possible
  requestAnimationFrame(function() {
    perfTimer.startTimer('setUpperCase:requestAnimationFrame:callback');
    // And make sure the caps lock key is highlighted correctly
    IMERender.setUpperCaseLock(isUpperCaseLocked ? 'locked' : isUpperCase);

    //restore the previous candidates
    IMERender.showCandidates(currentCandidates);

    perfTimer.printTime(
      'BLOCKING setUpperCase:requestAnimationFrame:callback',
      'setUpperCase:requestAnimationFrame:callback');
  });
}

function resetUpperCase() {
  if (isUpperCase &&
      !isUpperCaseLocked &&
      layoutManager.currentLayoutPage === LAYOUT_PAGE_DEFAULT) {
    setUpperCase(false);
  }
}

function isCapitalized() {
  return (isUpperCase || isUpperCaseLocked);
}

// Inform about a change in the displayed application via mutation observer
// http://hacks.mozilla.org/2012/05/dom-mutationobserver-reacting-to-dom-changes-without-killing-browser-performance/
function updateTargetWindowHeight(hide) {
  perfTimer.printTime('updateTargetWindowHeight');
  // height of the current active IME + 1px for the borderTop
  var imeHeight = IMERender.getHeight() + 1;
  var imeWidth = IMERender.getWidth();
  window.resizeTo(imeWidth, imeHeight);
}

// Sends a delete code to remove last character
// The argument specifies whether this is an auto repeat or not.
// We call triggerFeedback() for the initial press, but we
// purposefully do not call it again for auto repeating delete.
function sendDelete(isRepeat) {
  // Pass the isRepeat argument to the input method. It may not want
  // to compute suggestions, for example, if this is just one in a series
  // of repeating events.
  inputMethodManager.currentIMEngine.click(KeyboardEvent.DOM_VK_BACK_SPACE,
                                           null,
                                           isRepeat);
}

// Return the upper value for a key object
function getUpperCaseValue(key) {
  var hasSpecialCode = specialCodes.indexOf(key.keyCode) > -1;
  if (key.keyCode < 0 || hasSpecialCode || key.compositeKey)
    return key.value;

  var upperCase = layoutManager.currentModifiedLayout.upperCase || {};
  return upperCase[key.value] || key.value.toUpperCase();
}

function setMenuTimeout(press, id) {
  // Only set a timeout to show alternatives if there is one touch.
  // This avoids paving over menuTimeout with a new timeout id
  // from a separate touch.
  if (activeTargets.size > 1) {
    return;
  }

  menuTimeout = window.setTimeout(function menuTimeout() {
    // Don't try to show the alternatives menu if it's already showing,
    // or if there's more than one touch on the screen.
    if (isShowingAlternativesMenu || activeTargets.size > 1)
      return;

    var target = press.target;
    // The telLayout and numberLayout do not show an alternative key
    // menu, instead they send the alternative key and ignore the endPress.
    var currentInputType = fakeAppObject.getBasicInputType();
    if (currentInputType === 'number' || currentInputType === 'tel') {

      // Does the key have an altKey?
      var r = target.dataset.row, c = target.dataset.column;
      var keyChar = layoutManager.currentModifiedLayout.keys[r][c].value;
      var altKeys = layoutManager.currentModifiedLayout.alt[keyChar] || null;

      if (!altKeys)
        return;

      // Attach a dataset property that will be used to ignore
      // keypress in endPress
      target.dataset.ignoreEndPress = true;

      var keyCode = altKeys[0].charCodeAt(0);
      sendKey(keyCode);

      return;
    }

    showAlternatives(target);
    alternativesMenuTouchId = id;

    // If we successfuly showed the alternatives menu, redirect the
    // press over the first key in the menu.
    if (isShowingAlternativesMenu)
      movePress(press, id);

  }, ACCENT_CHAR_MENU_TIMEOUT);
}

// Show alternatives for the HTML node key
function showAlternatives(key) {
  // Get the key object from layout
  var keyObj;
  var r = key ? key.dataset.row : -1, c = key ? key.dataset.column : -1;
  if (r < 0 || c < 0 || r === undefined || c === undefined)
    return;
  keyObj = layoutManager.currentModifiedLayout.keys[r][c];

  // Handle languages alternatives
  if (keyObj.keyCode === SWITCH_KEYBOARD) {
    showIMEList();
    return;
  }

  // Hide the keyboard
  if (keyObj.keyCode === KeyEvent.DOM_VK_SPACE) {
    dismissKeyboard();
    return;
  }

  // Handle key alternatives
  var alternatives;
  var altMap = layoutManager.currentModifiedLayout.alt;

  if (isUpperCaseLocked) {
    alternatives = (altMap[getUpperCaseValue(keyObj)].upperCaseLocked) ?
      altMap[getUpperCaseValue(keyObj)].upperCaseLocked :
      altMap[getUpperCaseValue(keyObj)];
  } else if (isUpperCase) {
    alternatives = altMap[getUpperCaseValue(keyObj)];
  } else {
    alternatives = altMap[keyObj.value];
  }

  if (!alternatives || !alternatives.length) {
    return;
  }
  // Copy the array so render.js can't modify the original.
  alternatives = [].concat(alternatives);

  // Locked limits
  // TODO: look for [LOCKED_AREA]
  var top = getWindowTop(key);
  var bottom = getWindowTop(key) + key.scrollHeight;
  var keybounds = key.getBoundingClientRect();

  IMERender.showAlternativesCharMenu(key, alternatives);
  isShowingAlternativesMenu = true;

  // Locked limits
  // TODO: look for [LOCKED_AREA]
  menuLockedArea = {
    top: top,
    bottom: bottom,
    left: getWindowLeft(IMERender.menu),
    right: getWindowLeft(IMERender.menu) + IMERender.menu.scrollWidth
  };
  menuLockedArea.width = menuLockedArea.right - menuLockedArea.left;

  // Add some more properties to this locked area object that will help us
  // redirect touch events to the appropriate alternative key.
  menuLockedArea.keybounds = keybounds;
  menuLockedArea.firstAlternative =
    IMERender.menu.classList.contains('kbr-menu-left') ?
      IMERender.menu.lastElementChild :
      IMERender.menu.firstElementChild;
  menuLockedArea.boxes = [];
  var children = IMERender.menu.children;
  for (var i = 0; i < children.length; i++) {
    menuLockedArea.boxes[i] = children[i].getBoundingClientRect();
  }
}

// Hide alternatives.
function hideAlternatives() {
  if (!isShowingAlternativesMenu)
    return;

  IMERender.hideAlternativesCharMenu();
  isShowingAlternativesMenu = false;
  alternativesMenuTouchId = undefined;
}

// Test if an HTML node is a normal key
function isNormalKey(key) {
  var keyCode = parseInt(key.dataset.keycode);
  return keyCode || key.dataset.selection || key.dataset.compositeKey;
}

function getKeyCodeFromTarget(target) {
  return isUpperCase || isUpperCaseLocked ?
    parseInt(target.dataset.keycodeUpper, 10) :
    parseInt(target.dataset.keycode, 10);
}

function startPress(press, id) {
  activeTargets.set(id, press.target);

  if (!isNormalKey(press.target))
    return;

  if (isShowingAlternativesMenu)
    return;

  var keyCode = getKeyCodeFromTarget(press.target);

  // Feedback
  var isSpecialKey = specialCodes.indexOf(keyCode) >= 0 || keyCode < 0;
  triggerFeedback(isSpecialKey);
  IMERender.highlightKey(press.target, {
    isUpperCase: isUpperCase,
    isUpperCaseLocked: isUpperCaseLocked
  });

  setMenuTimeout(press, id);

  // Special keys (such as delete) response when pressing (not releasing)
  // Furthermore, delete key has a repetition behavior
  if (keyCode === KeyEvent.DOM_VK_BACK_SPACE) {

    // First repetition, after a delay (with feedback)
    deleteTimeout = window.setTimeout(function() {
      sendDelete(true);

      // Second, after shorter delay (with feedback too)
      deleteInterval = setInterval(function() {
        sendDelete(true);
      }, REPEAT_RATE);

    }, REPEAT_TIMEOUT);
  }
}

function inMenuLockedArea(lockedArea, press) {
  return (lockedArea &&
          press.pageY >= lockedArea.top &&
          press.pageY <= lockedArea.bottom &&
          press.pageX >= lockedArea.left &&
          press.pageX <= lockedArea.right);
}

// [LOCKED_AREA] TODO:
// This is an agnostic way to improve the usability of the alternatives.
// It consists into compute an area where the user movement is redirected
// to the alternative menu keys but I would prefer another alternative
// with better performance.
function movePress(press, id) {
  var target = press.target;
  // Control locked zone for menu
  if (isShowingAlternativesMenu && inMenuLockedArea(menuLockedArea, press)) {

    // If the x coordinate is between the bounds of the original key
    // then redirect to the first (or last) alternative. This is to
    // ensure that we always get the first alternative when the menu
    // first pops up.  Otherwise, loop through the children of the
    // menu and test each one. Once we have moved away from the
    // original keybounds we delete them and always loop through the children.
    if (menuLockedArea.keybounds &&
        press.pageX >= menuLockedArea.keybounds.left &&
        press.pageX < menuLockedArea.keybounds.right) {
      target = menuLockedArea.firstAlternative;
    }
    else {
      menuLockedArea.keybounds = null; // Do it this way from now on.
      var menuChildren = IMERender.menu.children;
      for (var i = 0; i < menuChildren.length; i++) {
        if (press.pageX >= menuLockedArea.boxes[i].left &&
            press.pageX < menuLockedArea.boxes[i].right) {
          break;
        }
      }
      target = menuChildren[i];
    }
  }

  if (isShowingAlternativesMenu && alternativesMenuTouchId !== id) {
    return;
  }

  var oldTarget = activeTargets.get(id);

  // Do nothing if there are invalid targets, if the user is touching the
  // same key, or if the new target is not a normal key.
  if (!target || !oldTarget || oldTarget == target || !isNormalKey(target))
    return;

  // Update highlight: remove from older
  IMERender.unHighlightKey(oldTarget);

  var keyCode = getKeyCodeFromTarget(target);

  // Update highlight: add to the new (Ignore if moving over delete key)
  if (keyCode != KeyEvent.DOM_VK_BACK_SPACE) {
    IMERender.highlightKey(target, {
      isUpperCase: isUpperCase,
      isUpperCaseLocked: isUpperCaseLocked
    });
  }

  activeTargets.set(id, target);

  clearTimeout(deleteTimeout);
  clearInterval(deleteInterval);
  clearTimeout(menuTimeout);

  // Hide of alternatives menu if the touch moved out of it
  if (target.parentNode !== IMERender.menu &&
      isShowingAlternativesMenu &&
      !inMenuLockedArea(menuLockedArea, press))
    hideAlternatives();

  // Control showing alternatives menu
  setMenuTimeout(press, id);
}

// The user is releasing a key so the key has been pressed. The meat is here.
function endPress(press, id) {
  var target = activeTargets.get(id);
  activeTargets.delete(id);

  if (isShowingAlternativesMenu && alternativesMenuTouchId !== id) {
    return;
  }

  clearTimeout(deleteTimeout);
  clearInterval(deleteInterval);
  clearTimeout(menuTimeout);

  hideAlternatives();

  if (target.classList.contains('dismiss-suggestions-button')) {
    if (inputMethodManager.currentIMEngine.dismissSuggestions) {
      inputMethodManager.currentIMEngine.dismissSuggestions();
    }
    return;
  }

  if (!target || !isNormalKey(target))
    return;

  // IME candidate selected
  var dataset = target.dataset;
  if (dataset.selection) {
    if (!press.moved) {
      IMERender.toggleCandidatePanel(false, true);

      if (inputMethodManager.currentIMEngine.select) {
        // We use dataset.data instead of target.textContent because the
        // text actually displayed to the user might have an ellipsis in it
        // to make it fit.
        inputMethodManager.currentIMEngine
          .select(target.textContent, dataset.data);
      }
    }

    IMERender.unHighlightKey(target);
    return;
  }

  IMERender.unHighlightKey(target);

  // The alternate keys of telLayout and numberLayout do not
  // trigger keypress on key release.
  if (target.dataset.ignoreEndPress) {
    delete target.dataset.ignoreEndPress;
    return;
  }

  var keyCode = getKeyCodeFromTarget(target);

  // Delete is a special key, it reacts when pressed not released
  if (keyCode == KeyEvent.DOM_VK_BACK_SPACE) {
    // The backspace key pressing is regarded as non-repetitive behavior.
    sendDelete(false);
    return;
  }

  // Reset the flag when a non-space key is pressed,
  // used in space key double tap handling
  if (keyCode != KeyEvent.DOM_VK_SPACE)
    isContinousSpacePressed = false;

  var keyStyle = getComputedStyle(target);
  if (keyStyle.display == 'none' || keyStyle.visibility == 'hidden')
    return;

  // Handle normal key
  switch (keyCode) {

  case BASIC_LAYOUT:
    // Return to default page
    fakeAppObject.setLayoutPage(layoutManager.LAYOUT_PAGE_DEFAULT);
    break;

  case ALTERNATE_LAYOUT:
    // Switch to numbers+symbols page
    fakeAppObject.setLayoutPage(layoutManager.LAYOUT_PAGE_SYMBOLS_I);
    break;

  case KeyEvent.DOM_VK_ALT:
    // alternate between pages 1 and 2 of SYMBOLS
    if (layoutManager.currentLayoutPage ===
        layoutManager.LAYOUT_PAGE_SYMBOLS_I) {
      fakeAppObject.setLayoutPage(layoutManager.LAYOUT_PAGE_SYMBOLS_II);
    } else {
      fakeAppObject.setLayoutPage(layoutManager.LAYOUT_PAGE_SYMBOLS_I);
    }
    break;

    // Switch language (keyboard)
  case SWITCH_KEYBOARD:
    switchToNextIME();
    break;

    // Expand / shrink the candidate panel
  case TOGGLE_CANDIDATE_PANEL:
    var candidatePanel = IMERender.candidatePanel;

    if (IMERender.ime.classList.contains('candidate-panel')) {
      var doToggleCandidatePanel = function doToggleCandidatePanel() {
        if (candidatePanel.dataset.truncated) {
          if (candidatePanelScrollTimer) {
            clearTimeout(candidatePanelScrollTimer);
            candidatePanelScrollTimer = null;
          }
          candidatePanel.addEventListener('scroll', candidatePanelOnScroll);
        }

        IMERender.toggleCandidatePanel(true, true);
      };

      if (candidatePanel.dataset.rowCount == 1) {
        var firstPageRows = 11;
        var numberOfCandidatesPerRow = IMERender.getNumberOfCandidatesPerRow();
        var candidateIndicator =
          parseInt(candidatePanel.dataset.candidateIndicator);

        if (inputMethodManager.currentIMEngine.getMoreCandidates) {
          inputMethodManager.currentIMEngine.getMoreCandidates(
            candidateIndicator,
            firstPageRows * numberOfCandidatesPerRow + 1,
            function getMoreCandidatesCallbackOnToggle(list) {
              if (candidatePanel.dataset.rowCount == 1) {
                IMERender.showMoreCandidates(firstPageRows, list);
                doToggleCandidatePanel();
              }
            }
          );
        } else {
          var list = currentCandidates.slice(candidateIndicator,
            candidateIndicator + firstPageRows * numberOfCandidatesPerRow + 1);

          IMERender.showMoreCandidates(firstPageRows, list);
          doToggleCandidatePanel();
        }
      } else {
        doToggleCandidatePanel();
      }
    } else {
      if (inputMethodManager.currentIMEngine.getMoreCandidates) {
        candidatePanel.removeEventListener('scroll', candidatePanelOnScroll);
        if (candidatePanelScrollTimer) {
          clearTimeout(candidatePanelScrollTimer);
          candidatePanelScrollTimer = null;
        }
      }

      IMERender.toggleCandidatePanel(false, true);
    }
    break;

    // Shift or caps lock
  case KeyEvent.DOM_VK_CAPS_LOCK:

    // Already waiting for caps lock
    if (isWaitingForSecondTap) {
      isWaitingForSecondTap = false;

      setUpperCase(true, true);

      // Normal behavior: set timeout for second tap and toggle caps
    } else {

      isWaitingForSecondTap = true;
      window.setTimeout(
        function() {
          isWaitingForSecondTap = false;
        },
        CAPS_LOCK_TIMEOUT
      );

      // Toggle caps
      setUpperCase(!isUpperCase, false);
    }
    break;

    // Normal key
  default:
    if (target.dataset.compositeKey) {
      // Keys with this attribute set send more than a single character
      // Like ".com" or "2nd" or (in Catalan) "l·l".
      var compositeKey = target.dataset.compositeKey;
      for (var i = 0; i < compositeKey.length; i++) {
        inputMethodManager.currentIMEngine.click(compositeKey.charCodeAt(i));
      }
    }
    else {
      inputMethodManager.currentIMEngine.click(
        parseInt(target.dataset.keycode, 10),
        parseInt(target.dataset.keycodeUpper, 10));
    }
    break;
  }
}

function candidatePanelOnScroll() {
  if (candidatePanelScrollTimer) {
    clearTimeout(candidatePanelScrollTimer);
    candidatePanelScrollTimer = null;
  }

  if (this.scrollTop != 0 &&
      this.scrollHeight - this.clientHeight - this.scrollTop < 5) {

    candidatePanelScrollTimer = setTimeout(function() {
      var pageRows = 12;
      var numberOfCandidatesPerRow = IMERender.getNumberOfCandidatesPerRow();
      var candidatePanel = IMERender.candidatePanel;
      var candidateIndicator =
        parseInt(candidatePanel.dataset.candidateIndicator);

      if (inputMethodManager.currentIMEngine.getMoreCandidates) {
        inputMethodManager.currentIMEngine.getMoreCandidates(
          candidateIndicator,
          pageRows * numberOfCandidatesPerRow + 1,
          IMERender.showMoreCandidates.bind(IMERender, pageRows)
        );
      } else {
        var list = currentCandidates.slice(candidateIndicator,
          candidateIndicator + pageRows * numberOfCandidatesPerRow + 1);

        IMERender.showMoreCandidates(pageRows, list);
      }
    }, 200);
  }
}

function getKeyCoordinateY(y) {
  var candidatePanel = IMERender.candidatePanel;

  var yBias = 0;
  if (candidatePanel)
    yBias = candidatePanel.clientHeight;

  return y - yBias;
}

function switchToNextIME() {
  deactivateInputMethod();
  var mgmt = navigator.mozInputMethod.mgmt;
  mgmt.next();
}

function showIMEList() {
  clearTouchedKeys();
  var mgmt = navigator.mozInputMethod.mgmt;
  mgmt.showAll();
}

// Turn to default values
function resetKeyboard() {
  layoutManager.updateLayoutPage(layoutManager.LAYOUT_PAGE_DEFAULT);

  // Don't call setUpperCase because renderKeyboard() should be invoked
  // separately after this function
  isUpperCase = false;
  isUpperCaseLocked = false;
}

// This is a wrapper around fakeAppObject.inputContext.sendKey()
// We use it in the defaultInputMethod and in the interface object
// we pass to real input methods
function sendKey(keyCode, isRepeat) {
  var inputContext = fakeAppObject.inputContext;

  switch (keyCode) {
  case KeyEvent.DOM_VK_BACK_SPACE:
    if (inputContext) {
      return inputContext.sendKey(keyCode, 0, 0, isRepeat);
    }
    break;
  case KeyEvent.DOM_VK_RETURN:
    if (inputContext) {
      return inputContext.sendKey(keyCode, 0, 0);
    }
    break;

  default:
    if (inputContext) {
      return inputContext.sendKey(0, keyCode, 0);
    }
    break;
  }
}

function replaceSurroundingText(text, offset, length) {
  var inputContext = fakeAppObject.inputContext;

  if (inputContext) {
    return inputContext.replaceSurroundingText(text, offset, length);
  } else {
    console.warn('no inputContext for replaceSurroudingText');
    return new Promise(function(res, rej) { rej(); });
  }
}

// Set up the keyboard and its input method.
// This is called when we get an event from mozInputMethod.
// The state argument is the data passed with that event, and includes
// the input field type, its inputmode, its content, and the cursor position.
function showKeyboard() {
  perfTimer.printTime('showKeyboard');
  clearTimeout(hideKeyboardTimeout);

  fakeAppObject.inputContext = navigator.mozInputMethod.inputcontext;

  resetKeyboard();

  if (!fakeAppObject.inputContext) {
    return;
  }

  // everything.me uses this setting to improve searches,
  // but they really shouldn't.
  settingsPromiseManager.set({
    'keyboard.current': layoutManager.currentLayoutName
  });

  // If we are already visible,
  // render the keyboard only after IMEngine is loaded.
  if (isKeyboardRendered) {
    switchIMEngine(true);

    return;
  }

  // render the keyboard right away w/o waiting for IMEngine
  // (it will be rendered again after imEngine is loaded)
  renderKeyboard();
  switchIMEngine(false);
}

// Hide keyboard
function hideKeyboard() {
  if (!isKeyboardRendered)
    return;

  deactivateInputMethod();

  clearTimeout(hideKeyboardTimeout);

  // For quick blur/focus events we don't want to hide the IME div
  // to avoid flickering and such

  hideKeyboardTimeout = setTimeout(function() {
    isKeyboardRendered = false;
  }, HIDE_KEYBOARD_TIMEOUT);

  // everything.me uses this setting to improve searches,
  // but they really shouldn't.
  settingsPromiseManager.set({
    'keyboard.current': undefined
  });

  clearTouchedKeys();
}

// Resize event handler
function onResize() {
  perfTimer.printTime('onResize');
  if (document.mozHidden) {
    return;
  }

  IMERender.resizeUI(layoutManager.currentModifiedLayout);
  updateTargetWindowHeight(); // this case is not captured by the mutation
  // observer so we handle it apart

  // TODO: need to check how to handle orientation change case to
  // show corrent word suggestions
  updateLayoutParams();
}

function switchIMEngine(mustRender) {
  perfTimer.printTime('switchIMEngine');

  var layout = layoutManager.currentModifiedLayout;
  var imEngineName = layout.imEngine || 'default';

  // dataPromise resolves to an array of data to be sent to imEngine.activate()
  var dataPromise = Promise.all(
    [inputContextGetTextPromise, imEngineSettings.initSettings()])
  .then(function(values) {
    perfTimer.printTime('switchIMEngine:dataPromise resolved');
    var inputContext = fakeAppObject.inputContext;

    // Resolve to this array
    return [
      layout.autoCorrectLanguage,
      {
        type: inputContext.inputType,
        inputmode: inputContext.inputMode,
        selectionStart: inputContext.selectionStart,
        selectionEnd: inputContext.selectionEnd,
        value: values[0],
        inputContext: inputContext
      },
      {
        suggest: values[1].suggestionsEnabled && !isGreekSMS(),
        correct: values[1].correctionsEnabled && !isGreekSMS()
      }
    ];
  }, function(error) {
    return Promise.reject(error);
  });

  inputContextGetTextPromise = null;

  var p = inputMethodManager.switchCurrentIMEngine(imEngineName, dataPromise);
  p.then(function() {
    perfTimer.printTime('switchIMEngine:promise resolved');
    // Render keyboard again to get updated info from imEngine
    if (mustRender || imEngineName !== 'default') {
      renderKeyboard();
    }

    // Load l10n library after IMEngine is loaded (if it's not loaded yet).
    l10nLoader.load();
  }, function() {
    console.warn('Failed to switch imEngine for ' + layout.layoutName + '.' +
      ' It might possible because we were called more than once.');
  });
}

// If the input method cares about layout details, get those details
// from the renderer and pass them on to the input method. This is called
// from renderKeyboard() each time the keyboard layout changes.
// As an optimzation, however, we only send parameters if layoutPage is
// the default, since the input methods we support don't do anything special
// for symbols
function updateLayoutParams() {
  if (inputMethodManager.currentIMEngine.setLayoutParams &&
      layoutManager.currentLayoutPage === LAYOUT_PAGE_DEFAULT) {
    inputMethodManager.currentIMEngine.setLayoutParams({
      keyboardWidth: IMERender.getWidth(),
      keyboardHeight: getKeyCoordinateY(IMERender.getHeight()),
      keyArray: IMERender.getKeyArray(),
      keyWidth: IMERender.getKeyWidth(),
      keyHeight: IMERender.getKeyHeight()
    });
  }
}

function triggerFeedback(isSpecialKey) {
  if (vibrationFeedbackSettings.initialized) {
    var vibrationFeedbackSettingsValues =
      vibrationFeedbackSettings.getSettingsSync();
    if (vibrationFeedbackSettingsValues.vibrationEnabled) {
      try {
        navigator.vibrate(50);
      } catch (e) {}
    }
  } else {
    console.warn(
      'Vibration feedback needed but settings is not available yet.');
  }

  if (soundFeedbackSettings.initialized) {
    var soundFeedbackSettingsValues = soundFeedbackSettings.getSettingsSync();
    if (soundFeedbackSettingsValues.clickEnabled &&
        !!soundFeedbackSettingsValues.isSoundEnabled) {
      (isSpecialKey ? specialClicker : clicker).cloneNode(false).play();
    }
  } else {
    console.warn(
      'Sound feedback needed but settings is not available yet.');
  }
}

// Utility functions
function getWindowTop(obj) {
  var top;
  top = obj.offsetTop;
  while (!!(obj = obj.offsetParent)) {
    top += obj.offsetTop;
  }
  return top;
}

function getWindowLeft(obj) {
  var left;
  left = obj.offsetLeft;
  while (!!(obj = obj.offsetParent)) {
    left += obj.offsetLeft;
  }
  return left;
}

// To determine if the candidate panel for word suggestion is needed
function needsCandidatePanel() {
  // Disable the word suggestion for Greek SMS layout.
  // This is because the suggestion result is still unicode and
  // we would not convert the suggestion result to GSM 7-bit.
  if (isGreekSMS()) {
    return false;
  }

  return !!((layoutManager.currentLayout.autoCorrectLanguage ||
           layoutManager.currentLayout.needsCandidatePanel) &&
          (!inputMethodManager.currentIMEngine.displaysCandidates ||
           inputMethodManager.currentIMEngine.displaysCandidates()));
}

// To determine if we need to show a "all uppercase layout" for Greek SMS
function isGreekSMS() {
  return (fakeAppObject.inputContext.inputMode === '-moz-sms' &&
          layoutManager.currentLayoutName === 'el');
}

// Remove the event listeners on the touched keys and the highlighting.
// This is because sometimes DOM element is removed before
// touchend is fired.
function clearTouchedKeys() {
  activeTargets.forEach(function cleanPress(el, id) {
    IMERender.unHighlightKey(el);
  });

  hideAlternatives();

  // Reset all the pending actions here.
  clearTimeout(deleteTimeout);
  clearInterval(deleteInterval);
  clearTimeout(menuTimeout);
}

// Hide the keyboard via input method API
function dismissKeyboard() {
  clearTimeout(deleteTimeout);
  clearInterval(deleteInterval);
  clearTimeout(menuTimeout);

  navigator.mozInputMethod.mgmt.hide();
}
